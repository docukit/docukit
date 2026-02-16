import type {
  DeleteDocRequest,
  DeleteDocResponse,
} from "../../shared/types.js";
import type { ClientSocket } from "../types.js";

export const handleDeleteDoc = async (
  socket: ClientSocket<object, object>,
  payload: DeleteDocRequest,
  timeoutMs = 5000,
): Promise<boolean> => {
  const response = await new Promise<DeleteDocResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout: delete-doc"));
    }, timeoutMs);
    socket.emit("delete-doc", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
  return response.success;
};
