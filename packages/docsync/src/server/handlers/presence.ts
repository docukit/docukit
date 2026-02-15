import type { Result } from "../../shared/types.js";

export type PresenceRequest = { docId: string; presence: unknown };
export type PresenceResponse = Result<void>;
export type PresenceHandler = (
  payload: PresenceRequest,
  cb: (res: PresenceResponse) => void,
) => void | Promise<void>;

type PresenceDeps = {
  applyPresenceUpdate: (args: { docId: string; presence: unknown }) => void;
};

export const createPresenceHandler = ({
  applyPresenceUpdate,
}: PresenceDeps) => {
  return async (
    { docId, presence }: PresenceRequest,
    cb: (res: PresenceResponse) => void,
  ): Promise<void> => {
    applyPresenceUpdate({ docId, presence });
    cb({ data: void undefined });
  };
};
