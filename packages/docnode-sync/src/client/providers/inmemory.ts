import type { ClientProvider } from "../index.js";
import type { JsonDocPayload, OpsPayload } from "../../shared/types.js";

export class InMemoryClientProvider implements ClientProvider {
  private _docs = new Map<string, JsonDocPayload>();
  private _operations: OpsPayload[] = [];

  async getJsonDoc(docId: string): Promise<JsonDocPayload | undefined> {
    return this._docs.get(docId);
  }

  async saveJsonDoc(json: JsonDocPayload): Promise<void> {
    this._docs.set(json.jsonDoc[0], json);
  }

  async cleanDB(): Promise<void> {
    this._docs.clear();
    this._operations = [];
  }

  async saveOperations(ops: OpsPayload): Promise<void> {
    this._operations.push(ops);
  }

  async getOperations(): Promise<OpsPayload[]> {
    return [...this._operations];
  }

  async deleteOperations(count: number): Promise<void> {
    if (count <= 0) return;
    this._operations.splice(0, count);
  }
}
