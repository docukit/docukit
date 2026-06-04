type ActionMap<State> = Record<string, (state: State, payload: never) => State>;

type PayloadOf<Handler> = Handler extends (
  state: never,
  payload: infer Payload,
) => unknown
  ? Payload
  : never;

type Dispatchers<State, Actions extends ActionMap<State>> = {
  [Name in keyof Actions & string]: (
    payload: PayloadOf<Actions[Name]>,
  ) => State;
};

export function createReducer<State, Actions extends ActionMap<State>>(config: {
  initialState: State;
  actions: Actions;
  beforeAction?: (
    state: State,
    action: {
      [Name in keyof Actions & string]: {
        type: Name;
        payload: PayloadOf<Actions[Name]>;
      };
    }[keyof Actions & string],
  ) => void;
}): { action: Dispatchers<State, Actions>; getState: () => State } {
  let state = config.initialState;
  const action = {} as Dispatchers<State, Actions>;

  for (const name of Object.keys(config.actions) as Array<
    keyof Actions & string
  >) {
    const reducer = config.actions[name] as (
      state: State,
      payload: PayloadOf<Actions[typeof name]>,
    ) => State;

    action[name] = ((payload: PayloadOf<Actions[typeof name]>) => {
      config.beforeAction?.(state, { type: name, payload });
      state = reducer(state, payload);
      return state;
    }) as Dispatchers<State, Actions>[typeof name];
  }

  return { action, getState: () => state };
}
