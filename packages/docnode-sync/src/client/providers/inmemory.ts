import { type JsonDoc, type Operations } from "docnode";
import type { ClientProvider } from "../index.js";
import type { DocNodeDB } from "./indexeddb.js";

export class InMemoryClientProvider implements ClientProvider {
  private _docs = new Map<string, JsonDoc>();
  private _operations: DocNodeDB["operations"]["value"][] = [];

  async getJsonDoc(docId: string): Promise<JsonDoc | undefined> {
    return this._docs.get(docId);
  }

  async saveJsonDoc(json: JsonDoc): Promise<void> {
    this._docs.set(json[0], json);
  }

  async cleanDB(): Promise<void> {
    this._docs.clear();
    this._operations = [];
  }

  async saveOperations(operations: Operations, docId: string): Promise<void> {
    this._operations.push({ i: docId, o: operations });
  }

  async getOperations(): Promise<DocNodeDB["operations"]["value"][]> {
    return [...this._operations];
  }

  async deleteOperations(count: number): Promise<void> {
    if (count <= 0) return;
    this._operations.splice(0, count);
  }
}
