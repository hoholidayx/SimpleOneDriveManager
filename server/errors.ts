export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function assert(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试'; }
