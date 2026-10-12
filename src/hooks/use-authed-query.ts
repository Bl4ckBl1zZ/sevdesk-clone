"use client";

import {
  type PaginatedQueryArgs,
  type PaginatedQueryReference,
  useConvexAuth,
  usePaginatedQuery,
  useQuery,
} from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";

/**
 * `useQuery` that waits until the Convex JWT is set: public functions reject unauthenticated calls (02 §4.4), so
 * subscribing before the token arrives would throw. Returns `undefined` while loading.
 */
export function useAuthedQuery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q>,
  enabled = true,
): FunctionReturnType<Q> | undefined {
  const { isAuthenticated } = useConvexAuth();
  return useQuery(query, ...((isAuthenticated && enabled ? [args] : ["skip"]) as [FunctionArgs<Q> | "skip"]));
}

/** `usePaginatedQuery` with the same wait-for-JWT behaviour (journal, lists). */
export function useAuthedPaginatedQuery<Q extends PaginatedQueryReference>(
  query: Q,
  args: PaginatedQueryArgs<Q>,
  initialNumItems: number,
) {
  const { isAuthenticated } = useConvexAuth();
  return usePaginatedQuery(query, isAuthenticated ? args : "skip", { initialNumItems });
}
