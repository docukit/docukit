import { type JsonDoc, type Operations } from "docnode";
import type { ClientProvider } from "../index.js";
import type { OpsPayload } from "../../shared/types.js";

export class InMemoryClientProvider implements ClientProvider {
  private _docs = new Map<string, JsonDoc>();
  private _operations: OpsPayload[] = [];

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

  async saveOperations(ops: Operations, docId: string): Promise<void> {
    this._operations.push({ docId, ops });
  }

  async getOperations(): Promise<OpsPayload[]> {
    return [...this._operations];
  }

  async deleteOperations(count: number): Promise<void> {
    if (count <= 0) return;
    this._operations.splice(0, count);
  }
}
