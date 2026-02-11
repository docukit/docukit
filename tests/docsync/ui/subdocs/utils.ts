import { expect, type Page, type Locator } from "@playwright/test";
import { HelperBase } from "../utils.js";

type ClientUtils = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  createChild: (arg: {
    parent: string;
    panel: "main" | "secondary";
  }) => Promise<void>;
  delete: (arg: { node: string; panel: "main" | "secondary" }) => Promise<void>;
};

export class DocNodeHelper extends HelperBase {
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;

  getDocnodes(client: Locator, panel: "main" | "secondary") {
    return client.locator(`.${panel}-doc .docnode`);
  }

  constructor(page: Page, docId: string) {
    super(page, docId);
    // Initialize client utils
    this.reference = this._createClientUtils(this._reference);
    this.otherTab = this._createClientUtils(this._otherTab);
    this.otherDevice = this._createClientUtils(this._otherDevice);
  }

  static override async create<T extends HelperBase>(
    this: new (page: Page, docId: string) => T,
    { page }: { page: Page },
  ): Promise<T> {
    const helper = await super.create({ page });
    await page.goto(`subdocs?docId=${helper.docId}`);
    await page.waitForLoadState("networkidle");
    await page.locator("#reference").first().waitFor({ state: "visible" });
    return helper as T;
  }

  private _createClientUtils(clientLocator: Locator): ClientUtils {
    // Extract client name from the locator's id (e.g., "#reference" -> "reference")
    const getClientName = async () => {
      const id = await clientLocator.getAttribute("id");
      if (!id) throw new Error("Client locator has no id");
      return id;
    };

    return {
      connect: async () => {
        const clientName = await getClientName();
        const toggleButton = this._page.getByTestId(
          `${clientName}-connection-toggle`,
        );

        // If offline, click to go online
        const buttonText = await toggleButton.textContent();
        if (buttonText?.includes("Offline")) {
          await toggleButton.click();
          // Wait for the button to show "Online"
          await toggleButton
            .getByText("🟢 Online")
            .waitFor({ state: "visible" });
        }
      },
      disconnect: async () => {
        const clientName = await getClientName();
        const toggleButton = this._page.getByTestId(
          `${clientName}-connection-toggle`,
        );

        // If online, click to go offline
        const buttonText = await toggleButton.textContent();
        if (buttonText?.includes("Online")) {
          await toggleButton.click();
          // Wait for the button to show "Offline"
          await toggleButton
            .getByText("🔴 Offline")
            .waitFor({ state: "visible" });
        }
      },
      createChild: async ({ parent, panel }) => {
        const docnodes = this.getDocnodes(clientLocator, panel);
        const countBefore = await docnodes.count();

        // Find docnode by data attribute using the specific client locator
        const targetDocnode = clientLocator
          .locator(`.${panel}-doc .docnode[data-node-value="${parent}"]`)
          .first();

        // Hover to make buttons visible, then click
        await targetDocnode.hover();
        const createButton = targetDocnode.locator("button.create");
        await createButton.click();
        const countAfter = await docnodes.count();
        expect(countAfter).toBe(countBefore + 1);

        // Wait a bit for the creation to propagate through the CRDT
        await this._page.waitForTimeout(60);
      },
      delete: async ({ node, panel }) => {
        // Find docnode by data attribute using the specific client locator
        const targetDocnode = clientLocator
          .locator(`.${panel}-doc .docnode[data-node-value="${node}"]`)
          .first();

        // Hover to make buttons visible, then click
        await targetDocnode.hover();
        const deleteButton = targetDocnode.locator("button.delete");
        await deleteButton.click();

        // Wait a bit for the delete to propagate through the CRDT
        await this._page.waitForTimeout(60);
      },
    };
  }

  private async _getNodesFromPanel(
    locator: Locator,
    panel: "main" | "secondary",
  ): Promise<Array<{ value: string; id: string; indent: number }>> {
    const docnodes = locator.locator(`.${panel}-doc .docnode`);
    const count = await docnodes.count();
    const nodes = [];

    for (let i = 0; i < count; i++) {
      const node = docnodes.nth(i);
      const value = await node.getAttribute("data-node-value");

      // Get the id from the second span (the one with text-zinc-600 class)
      const idSpan = node.locator("span.text-zinc-600");
      const id = await idSpan.textContent();

      if (!value || !id) throw new Error("no value or id found");

      // Get indent from the parent relative div's padding-left
      const parent = node.locator("..");
      const paddingLeft = await parent.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return parseInt(style.paddingLeft) || 0;
      });
      const indent = paddingLeft / 20; // 20px per indent level

      nodes.push({ value, id, indent });
    }

    return nodes;
  }

  private async _assertSync() {
    // Get nodes from reference (page) as the source of truth
    const referenceNodes = await this._getNodesFromPanel(
      this._reference,
      "main",
    );

    // Compare all clients against reference
    const clients = [
      { name: "otherTab (page)", locator: this._otherTab },
      { name: "otherDevice (page)", locator: this._otherDevice },
    ];

    for (const client of clients) {
      const clientNodes = await this._getNodesFromPanel(client.locator, "main");
      expect(clientNodes).toEqual(referenceNodes);
    }

    // Also compare hidden duplicates
    const hiddenClients = [
      { name: "reference-hidden (page)", locator: this._referenceHidden },
      { name: "otherTab-hidden (page)", locator: this._otherTabHidden },
      {
        name: "otherDevice-hidden (page)",
        locator: this._otherDeviceHidden,
      },
    ];

    for (const client of hiddenClients) {
      const clientNodes = await this._getNodesFromPanel(client.locator, "main");
      expect(clientNodes).toEqual(referenceNodes);
    }
  }

  async assertPanel(panel: "main" | "secondary", state: string[]) {
    state.unshift("root");
    const expectedCount = state.length;
    const docNodes = this.getDocnodes(this._reference, panel);
    // Wait for expected node count so sync has finished (CI is slower)
    await docNodes
      .nth(expectedCount - 1)
      .locator("span.text-zinc-600")
      .waitFor({ state: "visible", timeout: 15_000 });
    await this._assertSync();
    const count = await docNodes.count();

    // Get the left position of the root element to use as baseline
    const rootRect = await docNodes
      .nth(0)
      .evaluate((el) => el.getBoundingClientRect());
    const baseLeft = rootRect.left;

    for (let i = 0; i < count; i++) {
      const nodeValue = await docNodes.nth(i).getAttribute("data-node-value");

      if (i === 0) expect(nodeValue).toBe("root");
      else expect(nodeValue).toBe(state[i]?.replace(/__/g, ""));

      const rect = await docNodes
        .nth(i)
        .evaluate((el) => el.getBoundingClientRect());
      const indent = i === 0 ? 0 : (state[i]?.match(/__/g)?.length ?? 0) + 1;
      // Calculate relative position from the root element (20px per indent level)
      expect(rect.left - baseLeft).toBe(indent * 20);
    }
    await this._assertSync();
  }
}
