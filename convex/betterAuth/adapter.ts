import { createApi } from "@convex-dev/better-auth";
import { createAuthOptions } from "../auth";
import schema from "./schema";

/** Component adapter functions (the only code that writes Better Auth tables; allowlisted in 02 §3). */
export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany } = createApi(
  schema,
  createAuthOptions,
);
