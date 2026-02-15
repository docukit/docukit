export type DeleteDocRequest = { docId: string };
export type DeleteDocResponse = { success: boolean };
export type DeleteDocHandler = (
  payload: DeleteDocRequest,
  cb: (res: DeleteDocResponse) => void,
) => void | Promise<void>;

export type DeleteDocAuthorizeEvent<TContext = unknown> = {
  type: "delete-doc";
  payload: DeleteDocRequest;
  userId: string;
  context: TContext;
};

type DeleteDocDeps<TContext> = {
  userId: string;
  context: TContext;
  checkAuth: (event: DeleteDocAuthorizeEvent<TContext>) => Promise<boolean>;
};

export const createDeleteDocHandler = <TContext>({
  userId,
  context,
  checkAuth,
}: DeleteDocDeps<TContext>): DeleteDocHandler => {
  return async (payload, cb) => {
    const authorized = await checkAuth({
      type: "delete-doc",
      payload,
      userId,
      context,
    });
    if (!authorized) {
      cb({ success: false });
      return;
    }
    cb({ success: true });
  };
};
