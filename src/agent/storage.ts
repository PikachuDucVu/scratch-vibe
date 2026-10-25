import { isToolImage, type ChatMessage } from "../../shared/chat";

// IndexedDB keeps the project and conversations across reloads (localStorage is too small for .sb3).
const DB_NAME = "scratch-vibe", STORE = "kv";
let db: Promise<IDBDatabase> | null = null;
function open() {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { db = null; reject(request.error); };
  });
  return db;
}
async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await open()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const request = action(store);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}
export const storageGet = <T>(key: string) => run<T | undefined>("readonly", store => store.get(key)).catch(() => undefined);
export const storageSet = (key: string, value: unknown) => run<void>("readwrite", store => store.put(value, key));
export const storageDelete = (key: string) => run<void>("readwrite", store => store.delete(key));

export interface SavedProject { blob: Blob; savedAt: number }
export interface Conversation { id: string; title: string; updatedAt: number; messages: ChatMessage[] }
export type ConversationMeta = Omit<Conversation, "messages">;
const MAX_CONVERSATIONS = 30;

export function titleOf(messages: ChatMessage[]) {
  const first = messages.find(m => m.role === "user" && !isToolImage(m));
  const content = first?.role === "user" ? first.content : "";
  const text = typeof content === "string" ? content : content.find(p => p.type === "text")?.text ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "Hội thoại mới";
}
export async function listConversations(): Promise<ConversationMeta[]> {
  return (await storageGet<ConversationMeta[]>("conversations")) ?? [];
}
export async function loadConversation(id: string) {
  return storageGet<Conversation>(`conversation:${id}`);
}
// Saves one conversation and its index entry; keeps the newest MAX_CONVERSATIONS.
export async function saveConversation(conversation: Conversation) {
  await storageSet(`conversation:${conversation.id}`, conversation);
  const { messages: _messages, ...meta } = conversation;
  const list = [meta, ...(await listConversations()).filter(c => c.id !== conversation.id)].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of list.slice(MAX_CONVERSATIONS)) await storageDelete(`conversation:${old.id}`);
  await storageSet("conversations", list.slice(0, MAX_CONVERSATIONS));
  return list.slice(0, MAX_CONVERSATIONS);
}
export async function deleteConversation(id: string) {
  await storageDelete(`conversation:${id}`);
  const list = (await listConversations()).filter(c => c.id !== id);
  await storageSet("conversations", list);
  return list;
}
