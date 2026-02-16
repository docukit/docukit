import type { DeleteDocRequest } from "../../../shared/types.js";
import type { ClientSocket } from "../../types.js";
import { request } from "../../utils/request.js";

export const handleDeleteDoc = async (
  socket: ClientSocket<object, object>,
  payload: DeleteDocRequest,
  timeoutMs = 5000,
): Promise<boolean> => {
  const response = await request(socket, "delete-doc", payload, timeoutMs);
  return response.success;
};
