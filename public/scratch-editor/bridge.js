(function () {
  const SCRATCH_READY_TIMEOUT_MS = 30_000;
  const STAGE_READY_CHECK_INTERVAL_MS = 50;
  const params = new URLSearchParams(window.location.search);
  let parentOrigin = window.location.origin;
  const requestedParentOrigin = params.get("parentOrigin");
  if (requestedParentOrigin) {
    try {
      const requestedOrigin = new URL(requestedParentOrigin).origin;
      if (requestedOrigin === window.location.origin) {
        parentOrigin = requestedOrigin;
      }
    } catch {
      // Ignore invalid parentOrigin values and keep same-origin embedding.
    }
  }
  const rootElement = document.getElementById("scratch-root");
  const loadingElement = document.getElementById("scratch-loading");

  function errorMessage(error, fallback) {
    // Errors from the separate tools iframe have a different Error prototype.
    return error && typeof error.message === "string" ? error.message : fallback;
  }

  function post(message, transfer) {
    window.parent.postMessage(message, parentOrigin, transfer || []);
  }

  function getVm(editorState) {
    const state = editorState.store.getState();
    return state && state.scratchGui && state.scratchGui.vm;
  }

  function getProjectLoadingState(editorState) {
    const state = editorState.store.getState();
    return state && state.scratchGui && state.scratchGui.projectState && state.scratchGui.projectState.loadingState;
  }

  function hasStageTarget(vm) {
    return Boolean(vm && vm.runtime && typeof vm.runtime.getTargetForStage === "function" && vm.runtime.getTargetForStage());
  }

  function installMouseTargetGuard(vm) {
    if (!vm || vm.__examMouseTargetGuardInstalled || typeof vm.postIOData !== "function") return;

    const originalPostIOData = vm.postIOData;
    vm.postIOData = function (device, data) {
      if (device === "mouse" && !hasStageTarget(this)) return;
      return originalPostIOData.call(this, device, data);
    };
    vm.__examMouseTargetGuardInstalled = true;
  }

  function dispatchAction(editorState, action) {
    if (action) editorState.store.dispatch(action);
  }

  function requestProjectUpload(editorState) {
    if (typeof window.GUI.requestProjectUpload !== "function") return;
    dispatchAction(editorState, window.GUI.requestProjectUpload(getProjectLoadingState(editorState)));
  }

  function markProjectLoaded(editorState, success) {
    if (typeof window.GUI.onLoadedProject !== "function") return;
    dispatchAction(editorState, window.GUI.onLoadedProject(getProjectLoadingState(editorState), false, success));
  }

  function waitForStageTarget(editorState) {
    return new Promise(function (resolve, reject) {
      let interval = null;
      let timeout = null;
      let unsubscribe = null;

      function cleanup() {
        if (interval !== null) window.clearInterval(interval);
        if (timeout !== null) window.clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
      }

      function check() {
        const vm = getVm(editorState);
        installMouseTargetGuard(vm);

        if (hasStageTarget(vm)) {
          cleanup();
          resolve(vm);
        }
      }

      interval = window.setInterval(check, STAGE_READY_CHECK_INTERVAL_MS);
      timeout = window.setTimeout(function () {
        cleanup();
        reject(new Error("Scratch VM chưa tạo sân khấu. Vui lòng tải lại trang."));
      }, SCRATCH_READY_TIMEOUT_MS);
      unsubscribe = editorState.store.subscribe(check);
      check();
    });
  }

  async function start() {
    if (!window.GUI || !rootElement) {
      post({ type: "scratch:error", requestId: "startup", message: "Không tìm thấy Scratch GUI" });
      return;
    }

    window.GUI.setAppElement(rootElement);
    const editorState = new window.GUI.EditorState({ locale: "vi" });
    const gui = window.GUI.createStandaloneRoot(editorState, rootElement);
    let readyPosted = false;
    let readyPromise = null;
    const toolsReady = new Promise(function (resolve, reject) {
      if (window.__scratchVibeExecute) return resolve();
      const timer = window.setTimeout(function () {
        window.removeEventListener("vibe:tools-ready", loaded);
        reject(new Error("Không tải được tool runtime. Vui lòng tải lại trang."));
      }, 15000);
      function loaded() { window.clearTimeout(timer); resolve(); }
      window.addEventListener("vibe:tools-ready", loaded, { once: true });
    });
    // Attach a rejection handler immediately; readiness will report the error.
    toolsReady.catch(function () {});

    function postReadyWhenStageReady() {
      if (readyPosted) return readyPromise;
      if (!readyPromise) {
        readyPromise = Promise.all([waitForStageTarget(editorState), toolsReady])
          .then(function () {
            if (readyPosted) return;
            readyPosted = true;
            if (loadingElement) loadingElement.remove();
            post({ type: "scratch:ready" });
          })
          .catch(function (error) {
            if (!readyPosted) {
              post({ type: "scratch:error", requestId: "startup", message: error instanceof Error ? error.message : "Scratch VM chưa sẵn sàng" });
            }
          });
      }
      return readyPromise;
    }

    gui.render({
      assetHost: window.location.origin + "/api/scratch-assets",
      canEditTitle: true,
      canSave: false,
      backpackVisible: false,
      showComingSoon: false,
      onClickLogo: function () {},
      onProjectLoaded: function () {
        void postReadyWhenStageReady();
      },
      onVmInit: function (vm) {
        installMouseTargetGuard(vm);
      },
    });

    if (typeof window.GUI.setProjectId === "function") {
      dispatchAction(editorState, window.GUI.setProjectId(String(window.GUI.defaultProjectId || "0")));
    }
    void postReadyWhenStageReady();

    let queue = Promise.resolve();
    const seen = new Set();
    window.addEventListener("message", function (event) {
      if (event.origin !== parentOrigin || event.source !== window.parent) return;
      const message = event.data;
      if (!message || !["scratch:loadProject", "scratch:export", "scratch:tool", "scratch:upload"].includes(message.type)) return;
      if (typeof message.requestId !== "string" || message.requestId.length > 120 || seen.has(message.requestId)) return;
      seen.add(message.requestId);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
      queue = queue.then(function () { return handleMessage(event); }).catch(function (error) {
        post({ type: "scratch:error", requestId: message.requestId, message: error instanceof Error ? error.message : "Scratch request thất bại" });
      });
    });

    async function handleMessage(event) {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "scratch:upload") {
        await toolsReady;
        if (!(data.file instanceof ArrayBuffer) || typeof data.name !== "string") throw new Error("File không hợp lệ.");
        const result = window.__scratchVibeUpload(data.name, data.file);
        post({ type: "scratch:uploaded", requestId: data.requestId, result });
        return;
      }
      if (data.type === "scratch:tool") {
        await toolsReady;
        const toolVm = await waitForStageTarget(editorState);
        let backup = null;
        try {
          if (window.__scratchVibeMutating(data.name)) {
            backup = await (await toolVm.saveProjectSb3()).arrayBuffer();
          }
          const result = await window.__scratchVibeExecute(toolVm, data.name, data.args, {
            async loadProject(bytes) {
              requestProjectUpload(editorState);
              try {
                await toolVm.loadProject(bytes);
                markProjectLoaded(editorState, true);
                await waitForStageTarget(editorState);
              } catch (error) { markProjectLoaded(editorState, false); throw error; }
            }
          });
          if (JSON.stringify(result).length > 120000) throw new Error("Kết quả tool quá lớn. Hãy dùng project nhỏ hơn.");
          post({ type: "scratch:result", requestId: data.requestId, result });
        } catch (error) {
          if (backup) {
            toolVm.stopAll();
            requestProjectUpload(editorState);
            try {
              await toolVm.loadProject(backup);
              markProjectLoaded(editorState, true);
              await waitForStageTarget(editorState);
            } catch (rollbackError) {
              markProjectLoaded(editorState, false);
              throw new Error("Hoàn tác tự động thất bại; dùng nút Hoàn tác hoặc tải lại file .sb3. " + String(rollbackError));
            }
          }
          post({ type: "scratch:error", requestId: data.requestId, message: errorMessage(error, "Tool thất bại") });
        }
        return;
      }
      if (data.type !== "scratch:loadProject" && data.type !== "scratch:export") return;

      const vm = getVm(editorState);
      installMouseTargetGuard(vm);
      if (!vm) {
        post({ type: "scratch:error", requestId: data.requestId || "unknown", message: "Scratch VM chưa sẵn sàng" });
        return;
      }

      if (data.type === "scratch:loadProject" && typeof data.requestId === "string" && data.project instanceof ArrayBuffer) {
        requestProjectUpload(editorState);

        try {
          await vm.loadProject(data.project);
          markProjectLoaded(editorState, true);
          await waitForStageTarget(editorState);
          post({ type: "scratch:loaded", requestId: data.requestId });
        } catch (error) {
          markProjectLoaded(editorState, false);
          post({ type: "scratch:error", requestId: data.requestId, message: error instanceof Error ? error.message : "Không tải được project" });
        }
      }

      if (data.type === "scratch:export" && typeof data.requestId === "string") {
        try {
          await waitForStageTarget(editorState);
          const blob = await vm.saveProjectSb3();
          const buffer = await blob.arrayBuffer();
          post({ type: "scratch:exported", requestId: data.requestId, project: buffer }, [buffer]);
        } catch (error) {
          post({ type: "scratch:error", requestId: data.requestId, message: error instanceof Error ? error.message : "Không xuất được project" });
        }
      }
    }
  }

  start().catch(function (error) {
    post({ type: "scratch:error", requestId: "startup", message: error instanceof Error ? error.message : "Không khởi tạo được Scratch" });
  });
})();
