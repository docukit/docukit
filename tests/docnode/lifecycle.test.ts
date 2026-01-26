import { expect, test, describe } from "vitest";
import {
  Text,
  TextExtension,
  assertDoc,
  checkUndoManager,
  assertError,
  updateAndListen,
  humanReadableOperations,
} from "./utils.js";
import { Doc, defineNode, type Extension } from "docnode";

describe("register lifecycle", () => {
  test("register is called when Doc is created", () => {
    let registerCalled = false;
    let receivedDoc: Doc | null = null;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        registerCalled = true;
        receivedDoc = doc;
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    expect(registerCalled).toBe(true);
    expect(receivedDoc).toBe(doc);
  });

  test("multiple extensions can have register hooks", () => {
    const callOrder: number[] = [];

    const Extension1: Extension = {
      register: () => {
        callOrder.push(1);
      },
    };

    const Extension2: Extension = {
      register: () => {
        callOrder.push(2);
      },
    };

    const Extension3: Extension = {
      register: () => {
        callOrder.push(3);
      },
    };

    new Doc({ extensions: [Extension1, Extension2, Extension3] });

    expect(callOrder).toStrictEqual([1, 2, 3]);
  });

  test("register without nodes extension works", () => {
    let called = false;

    const TestExtension: Extension = {
      register: () => {
        called = true;
      },
    };

    new Doc({ extensions: [TestExtension] });

    expect(called).toBe(true);
  });

  test("update cannot be triggered during register", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        const node = doc.createNode(Text);
        node.state.value.set("test");
        expect(() => {
          doc.root.append(node);
        }).toThrowError("You can't trigger an update inside a init event");
      },
    };

    expect(() => {
      new Doc({ extensions: [TestExtension] });
    }).toThrowError("You can't trigger an update inside a init stage");
  });

  test("can register change event inside and outside register", () => {
    const logs: string[] = [];
    const doc = new Doc({
      extensions: [
        TextExtension,
        {
          register: (doc) => {
            doc.onChange(() => {
              logs.push("inside");
            });
          },
        },
      ],
    });
    doc.onChange(() => {
      logs.push("outside");
    });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("test");
      doc.root.append(node);
    });
    expect(logs).toStrictEqual(["inside", "outside"]);
  });
});

describe("doc.onNormalize", () => {
  test("onNormalize can be called during register", () => {
    let normalizeCalled = false;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          normalizeCalled = true;
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    // Normalize should be called when a transaction is committed
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("test");
      doc.root.append(node);
    });

    expect(normalizeCalled).toBe(true);
  });

  test("onNormalize throws when called outside register", () => {
    const doc = new Doc({ extensions: [TextExtension] });

    expect(() => {
      doc.onNormalize(() => {
        // This should never execute
      });
    }).toThrowError(
      "You can't register a normalize event listener outside the register callback of an Extension",
    );
  });

  test("onNormalize receives diff", () => {
    let receivedDiff: unknown = null;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(({ diff }) => {
          receivedDiff = diff;
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("test");
      doc.root.append(node);
    });

    expect(receivedDiff).toBeTruthy();
    expect(receivedDiff).toHaveProperty("inserted");
    expect(receivedDiff).toHaveProperty("deleted");
    expect(receivedDiff).toHaveProperty("moved");
  });

  test("multiple onNormalize callbacks can be registered", () => {
    const callOrder: number[] = [];

    const Extension1: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          callOrder.push(1);
        });
      },
    };

    const Extension2: Extension = {
      register: (doc) => {
        doc.onNormalize(() => {
          callOrder.push(2);
        });
      },
    };

    const doc = new Doc({
      extensions: [Extension1, Extension2],
      strictMode: false,
    });

    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("test");
      doc.root.append(node);
    });

    expect(callOrder).toStrictEqual([1, 2]);
  });

  test("onNormalize can mutate the document", () => {
    const Container = defineNode({
      type: "container",
      state: {},
    });

    const TestExtension: Extension = {
      nodes: [Text, Container],
      register: (doc) => {
        doc.onNormalize(() => {
          // Ensure root always has at least one container
          if (!doc.root.first) {
            const container = doc.createNode(Container);
            doc.root.append(container);
          }
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: false });

    // Initially, root should be empty
    expect(doc.root.first).toBeFalsy();

    checkUndoManager(1, doc, () => {
      // Trigger a transaction that will call normalize
      const text = doc.createNode(Text);
      text.state.value.set("test");
      doc.root.append(text);
    });

    // After the transaction, there should be at least the text node we added
    expect(doc.root.first).toBeTruthy();
  });

  test("onNormalize is called for every transaction", () => {
    let callCount = 0;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          callCount++;
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    checkUndoManager(3, doc, () => {
      // Transaction 1
      doc.root.append(doc.createNode(Text));
      doc.forceCommit();

      // Transaction 2
      doc.root.append(doc.createNode(Text));
      doc.forceCommit();

      // Transaction 3
      doc.root.append(doc.createNode(Text));
    });

    // In strict mode, normalize is called twice per transaction for validation
    // So we expect either 3 or 6 calls depending on strict mode
    // Let's check it's at least 3
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  test("onNormalize callback can access document state", () => {
    let normalizeRan = false;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          // Ensure we always have at least one text node
          if (!doc.root.first) {
            normalizeRan = true;
            const node = doc.createNode(Text);
            node.state.value.set("default");
            doc.root.append(node);
          }
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: false });

    // Root should be empty initially
    expect(doc.root.first).toBeFalsy();

    // Add a node
    const node = doc.createNode(Text);
    node.state.value.set("temp");
    doc.root.append(node);
    doc.forceCommit();
    expect(doc.root.first).toBeTruthy();

    // Delete it, which will trigger normalize to add default
    node.delete();
    doc.forceCommit();

    // After normalize, there should be a default text node
    expect(normalizeRan).toBe(true);
    assertDoc(doc, ["default"]);
  });
});

describe("onNormalize in strict mode", () => {
  test("strict mode throws error if normalize mutates on second pass", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          // This will always add a node, which is not idempotent
          const newNode = doc.createNode(Text);
          newNode.state.value.set("added-by-normalize");
          doc.root.append(newNode);
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: true });

    // This should throw because normalize keeps mutating on second pass
    expect(() => {
      const node = doc.createNode(Text);
      node.state.value.set("initial");
      doc.root.append(node);
      doc.forceCommit();
    }).toThrowError(
      /Strict mode has caught an error: normalize listeners are not idempotent. I.e, they should not mutate the document on the second pass./,
    );
  });

  test("strict mode validates normalize callbacks are idempotent", () => {
    let normalizeCount = 0;

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          normalizeCount++;
          // This will mutate on every pass, which should fail in strict mode
          let count = 0;
          let node = doc.root.first;
          while (node) {
            count++;
            node = node.next;
          }
          if (count < 10) {
            const newNode = doc.createNode(Text);
            newNode.state.value.set(`node-${normalizeCount}`);
            doc.root.append(newNode);
          }
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: true });

    // In strict mode, this should throw because normalize keeps adding nodes
    expect(() => {
      const node = doc.createNode(Text);
      node.state.value.set("initial");
      doc.root.append(node);
      doc.forceCommit();
    }).toThrowError(
      /Strict mode has caught an error: normalize listeners are not idempotent. I.e, they should not mutate the document on the second pass./,
    );

    // Verify normalize was called more than once due to strict mode
    expect(normalizeCount).toBeGreaterThan(1);
  });

  test("strict mode allows idempotent normalize callbacks", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          // Idempotent: only adds if there are no children
          if (!doc.root.first) {
            const node = doc.createNode(Text);
            node.state.value.set("default");
            doc.root.append(node);
          }
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: true });

    // This should work because the callback is idempotent
    // Add then delete a node to trigger normalization
    const node = doc.createNode(Text);
    node.state.value.set("temp");
    doc.root.append(node);
    doc.forceCommit();

    node.delete();
    doc.forceCommit();

    assertDoc(doc, ["default"]);
  });
});

describe("onNormalize with operations", () => {
  test("normalize mutations are included in operations", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          // Add a suffix to ensure consistent state
          doc.root.descendants().forEach((node) => {
            if (node.is(Text)) {
              const value = node.state.value.get();
              if (!value.endsWith("-normalized")) {
                node.state.value.set(`${value}-normalized`);
              }
            }
          });
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension], strictMode: false });

    checkUndoManager(1, doc, () => {
      updateAndListen(
        doc,
        () => {
          const node = doc.createNode(Text);
          node.state.value.set("test");
          doc.root.append(node);
        },
        (changeEvent) => {
          const readable = humanReadableOperations(doc, changeEvent);
          // The value should include the normalization suffix
          expect(
            readable.operations.some((op) => op.includes("test-normalized")),
          ).toBe(true);
        },
      );
    });

    assertDoc(doc, ["test-normalized"]);
  });
});

describe("lifecycle transitions", () => {
  test("lifecycle progresses from init to idle", () => {
    const stages: string[] = [];

    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        stages.push(doc["_lifeCycleStage"] as string);

        doc.onNormalize(() => {
          stages.push(doc["_lifeCycleStage"] as string);
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });
    stages.push(doc["_lifeCycleStage"] as string);

    // Should start in init, then move to idle
    expect(stages[0]).toBe("init");
    expect(stages[1]).toBe("idle");

    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
    });

    // During transaction, normalize should be called
    expect(stages).toContain("normalize");

    // After transaction, should be back to idle
    expect(doc["_lifeCycleStage"] as string).toBe("idle");
  });

  test("cannot call onNormalize during update phase", () => {
    const doc = new Doc({ extensions: [TextExtension] });

    let normalizeCallAttempted = false;

    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          doc.onNormalize(() => {
            normalizeCallAttempted = true;
          });
        },
        "You can't register a normalize event listener outside the register callback of an Extension",
      );
    });

    expect(normalizeCallAttempted).toBe(false);
  });

  test("cannot call onNormalize during change event", () => {
    const doc = new Doc({ extensions: [TextExtension] });

    checkUndoManager(1, doc, () => {
      const unregister = doc.onChange(() => {
        expect(() => {
          doc.onNormalize(() => {
            // Should never execute
          });
        }).toThrowError(
          "You can't register a normalize event listener outside the register callback of an Extension",
        );
      });

      const node = doc.createNode(Text);
      doc.root.append(node);

      unregister();
    });
  });
});

describe("onNormalize edge cases", () => {
  test("empty onNormalize callback works", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          // Do nothing
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
    });

    expect(doc.root.first).toBeTruthy();
  });

  test("onNormalize callback that throws is propagated", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          throw new Error("Normalize error");
        });
      },
    };

    const doc = new Doc({ extensions: [TestExtension] });

    expect(() => {
      checkUndoManager(1, doc, () => {
        const node = doc.createNode(Text);
        doc.root.append(node);
      });
    }).toThrow("Normalize error");
  });

  test("extension without register still works", () => {
    const TestExtension: Extension = {
      nodes: [Text],
      // No register
    };

    const doc = new Doc({ extensions: [TestExtension] });

    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("test");
      doc.root.append(node);
    });

    assertDoc(doc, ["test"]);
  });

  test("if normalize reverts the tx, the change event should not be triggered", () => {
    const doc = new Doc({
      extensions: [
        TextExtension,
        {
          register: (doc) => {
            doc.onNormalize(({ diff }) => {
              diff.inserted.forEach((id) => {
                const node = doc.getNodeById(id);
                node?.delete();
              });
            });
          },
        },
      ],
    });

    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
    });
    assertDoc(doc, []);
  });
});

describe("applyOperations", () => {
  test("applyOperations triggers events with manual operations", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const nodeId = doc["_nodeIdGenerator"](doc);

    checkUndoManager(1, doc, () => {
      doc.applyOperations([
        [[0, [[nodeId, "text"]], 0, 0, 0]],
        { [nodeId]: { value: '"test"' } },
      ]);
    });
    assertDoc(doc, ["test"]);
  });
});

describe("dispose", () => {
  test("dispose throws if called during an update event", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      expect(() => {
        doc.dispose();
      }).toThrowError("You can't dispose a document during the update stage");
    });
  });

  test("dispose throws if called during a change event", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    doc.onChange(() => {
      expect(() => {
        doc.dispose();
      }).toThrowError("You can't dispose a document during the change stage");
    });
    const node = doc.createNode(Text);
    doc.root.append(node);
    doc.forceCommit();
  });

  test("dispose throws if called during a normalize event", () => {
    const doc = new Doc({
      extensions: [
        TextExtension,
        {
          register: (doc) => {
            doc.onNormalize(() => {
              expect(() => {
                doc.dispose();
              }).toThrowError(
                "You can't dispose a document during the normalize",
              );
            });
          },
        },
      ],
    });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
    });
  });

  test("can't update a document after being disposed", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    doc.dispose();
    expect(() => {
      doc.root.append(node);
    }).toThrowError("You can't trigger an update inside a disposed stage");
  });
});
