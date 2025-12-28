import { describe, expect, expectTypeOf, test } from "vitest";
import { Doc, DocNode, defineState, defineNode, string } from "docnode";
import type {
  Json,
  StateDefinition,
  NodeDefinition,
  DefaultStateMethods,
  JsonDoc,
} from "docnode";
import {
  checkUndoManager,
  TestNode,
  Text,
  TextExtension,
  TestExtension,
} from "./utils.js";

describe("types", () => {
  test("Json", () => {
    // [#type-fest] - copied as it is from type-fest
    // The reason why objects with undefined values ​​are allowed is explained here:
    // - https://github.com/sindresorhus/type-fest/pull/65
    // - https://github.com/sindresorhus/type-fest/issues/64
    expectTypeOf<Record<string, undefined>>().toExtend<Json>();
    expectTypeOf<undefined>().not.toExtend<Json>();
    expectTypeOf<["a", "b"]>().toExtend<Json>();
    expectTypeOf<{ toJSON(): Json }>().not.toExtend<Json>();
    expectTypeOf<{ toJSON(): string }>().not.toExtend<Json>();
    expectTypeOf<{ toJSON(): undefined }>().not.toExtend<Json>();
  });

  test("DocNode.toJSON", () => {
    expectTypeOf<
      ReturnType<DocNode<typeof TestNode>["toJSON"]>
    >().toEqualTypeOf<
      [
        string,
        "test",
        {
          string?: string;
          number?: string;
          boolean?: string;
          date?: string;
        },
      ]
    >();
  });

  test("JsonDoc", () => {
    // this one only works with "exactOptionalPropertyTypes": true
    // but most people don't use it because it's not included in 'strict'
    // for historical reasons
    expectTypeOf<
      ["1", "text", { value: "1" }, undefined]
    >().not.toMatchTypeOf<JsonDoc>();

    expectTypeOf<["1", "text", { value: "1" }]>().toMatchTypeOf<JsonDoc>();

    expectTypeOf<
      ["1", "text", { value: "1" }, []]
    >().not.toMatchTypeOf<JsonDoc>();

    expectTypeOf<
      ["1", "text", { value: "1" }, [["2", "text", { value: "2" }]]]
    >().toMatchTypeOf<JsonDoc>();
  });

  describe("stateDefinition type", () => {
    test("stateDefinition type", () => {
      expectTypeOf<
        StateDefinition<string, string, DefaultStateMethods<string>>
      >().toEqualTypeOf<{
        fromJSON: (json: unknown) => string;
        toJSON?: (value: string) => string;
        methods?: (
          methods: DefaultStateMethods<string>,
        ) => DefaultStateMethods<string>;
      }>();
      expectTypeOf<
        StateDefinition<Date, string, DefaultStateMethods<Date>>
      >().toEqualTypeOf<{
        fromJSON: (json: unknown) => Date;
        // I could detect that toJSON here is required,
        // but the extra complexity is not worth it
        toJSON?: (value: Date) => string;
        methods?: (
          methods: DefaultStateMethods<Date>,
        ) => DefaultStateMethods<Date>;
      }>();
      // @ts-expect-error - undefined is not JSON serializable
      type _SerializableError = StateDefinition<Error, undefined>;
      type _SerializableOk = StateDefinition<Error, null>;
    });
  });

  describe("defineState", () => {
    test("toJSON shouldn't be required if V is not JSON serializable", () => {
      // At one point I considered making defineState throw an error
      // if V is not json serializable and a toJson is not defined.
      // Here's a counterexample of why that's not a good idea.
      //
      // JSON.stringify works in many cases (it only throws errors with
      // circular references and BigInt). As long as you know how to
      // revive it, a toJSON isn't necessary.
      // See also: https://github.com/facebook/lexical/pull/7117#discussion_r1955117631
      //
      // Also, this test caught a couple of bugs, so it shouldn't be removed.
      class A {
        counter: number;

        constructor(counter = 0) {
          this.counter = counter;
        }
        increment() {
          this.counter++;
        }
      }
      const CounterNode = defineNode({
        type: "counter",
        state: {
          counter: defineState({
            fromJSON: (json: unknown) => {
              if (json === undefined) return new A();
              if (
                typeof json !== "object" ||
                json === null ||
                !("counter" in json) ||
                typeof json.counter !== "number"
              )
                throw new Error("Invalid JSON");
              return new A(json.counter);
            },
          }),
        },
      });
      const doc = new Doc({ extensions: [{ nodes: [CounterNode] }] });
      checkUndoManager(1, doc, () => {
        const node = doc.createNode(CounterNode);
        doc.root.append(node);
        node.state.counter.set((current) => {
          current.increment();
          current.increment();
          return current;
        });
        expect(node.state.counter.get().counter).toBe(2);
        const json = doc.toJSON({ unsafe: true });
        const doc2 = Doc.fromJSON(
          { extensions: [{ nodes: [CounterNode] }] },
          json,
        );
        const node2 = doc2.root.first as DocNode<typeof CounterNode>;
        expect(node2.state.counter.get().counter).toBe(2);
      });
    });
    test("if toJSON is not defined should be inferred from fromJSON", () => {
      const state = defineState({
        fromJSON: () => "" as string,
      });
      expectTypeOf(state).toEqualTypeOf<
        StateDefinition<string, string, DefaultStateMethods<string>>
      >();
    });
    test("toJSON is not defined and fromJSON returns non-jsonifiable", () => {
      const state = defineState({
        fromJSON: () => () => "this is a function!",
        toJSON: () => "this is a function!",
      });
      expectTypeOf(state).toEqualTypeOf<
        StateDefinition<
          () => "this is a function!",
          "this is a function!",
          DefaultStateMethods<() => "this is a function!">
        >
      >();
    });
    test("fromJson returns json but toJSON is still defined and returns something different", () => {
      const jsonifiable = defineState({
        fromJSON: (json) => Number(json),
        toJSON: (value) => String(value),
      });
      expectTypeOf(jsonifiable).toEqualTypeOf<
        StateDefinition<number, string, DefaultStateMethods<number>>
      >();
    });
    test("undefined is the default value", () => {
      const state = defineState({
        fromJSON: (json) => (typeof json === "string" ? json : undefined),
      });
      // The important thing here is that J is inferred as Json and not as a string | undefined .
      // At runtime, this will fail in the Doc constructor.
      expectTypeOf(state).toEqualTypeOf<
        StateDefinition<
          string | undefined,
          Json,
          DefaultStateMethods<string | undefined>
        >
      >();
      const MyNode = defineNode({
        type: "myNode",
        state: {
          value: state,
        },
      });
      expect(() => new Doc({ extensions: [{ nodes: [MyNode] }] })).toThrowError(
        `JSON serialization of the default value for state 'value' of node type 'myNode' is 'undefined', which is not allowed.`,
      );
    });
    test("Date inline inference should infer J as string", () => {
      // Standalone case - should infer J as string
      const dateStandalone = defineState({
        fromJSON: (json) =>
          typeof json === "string" ? new Date(json) : new Date(0),
      });
      expectTypeOf(dateStandalone).toEqualTypeOf<
        StateDefinition<Date, string, DefaultStateMethods<Date>>
      >();

      // Inline case - should also infer J as string (was incorrectly Json before fix)
      const TestNode = defineNode({
        type: "test",
        state: {
          dateInline: defineState({
            fromJSON: (json) =>
              typeof json === "string" ? new Date(json) : new Date(0),
          }),
        },
      });

      // Verify the inline definition has correct type
      expectTypeOf(TestNode.state.dateInline).toEqualTypeOf<
        StateDefinition<Date, string, DefaultStateMethods<Date>>
      >();
    });
    // eslint-disable-next-line vitest/expect-expect
    test("fromJSON cannot be assigned to anything other than unknown", () => {
      defineState({
        // @ts-expect-error - fromJSON cannot be assigned to anything other than unknown
        fromJSON: (json: string) => json,
      });
    });
  });

  describe("defineNode", () => {
    test("return type", () => {
      expectTypeOf(TestNode).toEqualTypeOf<
        // Maybe it would be nice if defineNode worked like classes, which automatically creates
        // a value (the class) and a type (the instance's type). So when people hover over a
        // nodeDefinition they would see Paragraph, and over a node DocNode<Paragraph>, and
        // they wouldn't see this long type when creating a node, nor would they have to do
        // DocNode<typeof Paragraph>. See:
        // - https://github.com/microsoft/TypeScript/issues/60254
        // - https://github.com/microsoft/TypeScript/issues/13798
        NodeDefinition<
          "test",
          {
            string: StateDefinition<
              string,
              string,
              DefaultStateMethods<string>
            >;
            number: StateDefinition<
              number,
              number,
              DefaultStateMethods<number>
            >;
            boolean: StateDefinition<
              boolean,
              0 | 1,
              DefaultStateMethods<boolean>
            >;
            date: StateDefinition<Date, string, DefaultStateMethods<Date>>;
          }
        >
      >();
    });

    test("NodeDefinition without type parameter", () => {
      expectTypeOf<NodeDefinition>().toEqualTypeOf<
        NodeDefinition<string, Record<never, never>>
      >();
      expectTypeOf<NodeDefinition["state"]>().toEqualTypeOf<
        Record<never, never>
      >();
    });
    test("DocNode without NodeDefinition should not accept unknown keys", () => {
      const doc = new Doc({ extensions: [TestExtension] });
      const unknownNode = doc.root as unknown as DocNode;
      const state = unknownNode.state;
      expectTypeOf(state).toEqualTypeOf<Record<never, never>>();
      // @ts-expect-error - unknown key
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const _stringState = unknownNode.state.string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expectTypeOf(_stringState).toEqualTypeOf<any>();
    });

    test("NodeState.State", () => {
      const doc = new Doc({ extensions: [TestExtension] });
      const node = doc.createNode(TestNode);
      expectTypeOf(node["_state"]).toEqualTypeOf<{
        string?: string;
        number?: number;
        boolean?: boolean;
        date?: Date;
      }>();
      const unknown = node as DocNode;
      expectTypeOf(unknown["_state"]).toEqualTypeOf<Record<never, never>>();
    });
  });
});

describe("new Doc", () => {
  test("nodes with same type and colliding states - should throw", () => {
    const TextColliding = defineNode({
      type: "text",
      state: {
        value: string(""),
      },
    });
    expect(
      () => new Doc({ extensions: [{ nodes: [TextColliding, Text] }] }),
    ).toThrowError(
      "Collision error: attempt to register 2 node definitions of type 'text' " +
        "that share the state property value. Remove that and any other " +
        "repeated states in either of the two node definitions.",
    );
  });

  describe("document id validation", () => {
    test("should throw for invalid ULID (wrong characters)", () => {
      expect(
        () => new Doc({ extensions: [TextExtension], id: "invalid-id" }),
      ).toThrowError(
        "Invalid document id: invalid-id. It must be a lowercase ULID.",
      );
    });

    test("should throw for uppercase ULID", () => {
      // Uppercase ULIDs should be rejected - user should normalize to lowercase
      expect(
        () =>
          new Doc({
            extensions: [TextExtension],
            id: "01KCFHZZ66V3393XHGGX6AEB6T",
          }),
      ).toThrowError(
        "Invalid document id: 01KCFHZZ66V3393XHGGX6AEB6T. It must be a lowercase ULID.",
      );
    });

    test("should accept valid lowercase ULID", () => {
      const doc = new Doc({
        extensions: [TextExtension],
        id: "01kcfhzz66v3393xhggx6aeb6t",
      });
      expect(doc.root.id).toBe("01kcfhzz66v3393xhggx6aeb6t");
    });

    test("should auto-generate lowercase ULID when id is not provided", () => {
      const doc = new Doc({ extensions: [TextExtension] });
      // Generated ULIDs should be lowercase and 26 characters
      expect(doc.root.id).toMatch(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    });
  });
});

describe("createNode", () => {
  test("create node with definition not registered should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const fn = () => doc.root.append(doc.createNode(TestNode));
    expect(fn).toThrowError(
      "You attempted to create a node of type 'test' with a node definition that was not registered.",
    );
  });

  test("create node outside of a transaction should NOT throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    expect(node).toBeDefined();
  });

  // eslint-disable-next-line vitest/expect-expect
  test("private constructor", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    // @ts-expect-error - private constructor
    new DocNode(doc, "text");
  });
});
