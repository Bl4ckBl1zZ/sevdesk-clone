"use client";

import type * as React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface ListColumn<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  numeric?: boolean;
  /** Hidden in the card layout (e.g. the checkbox column, which the card renders itself). */
  tableOnly?: boolean;
}

/**
 * A table on wide containers and cards on phones (04-ui-ux §4.1, CLAUDE.md rule 9: container queries in the main
 * area). The first column is the card title; the others become „Label: Wert“ lines.
 */
export function ResponsiveList<T>({
  rows,
  columns,
  rowKey,
  label,
  testId,
  cardLead,
  rowClassName,
}: {
  rows: readonly T[];
  columns: readonly ListColumn<T>[];
  rowKey: (row: T) => string;
  label: string;
  testId?: string;
  /** Rendered before the card title (e.g. a selection checkbox). */
  cardLead?: (row: T) => React.ReactNode;
  rowClassName?: (row: T) => string | undefined;
}) {
  const [first, ...rest] = columns.filter((c) => !c.tableOnly);
  return (
    <div className="@container/list" data-testid={testId}>
      <div className="hidden @3xl/list:block">
        <Table aria-label={label}>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={cn(c.numeric && "text-right")}>
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={rowKey(r)} className={rowClassName?.(r)} data-row={rowKey(r)}>
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(c.numeric && "text-right tabular-nums")}>
                    {c.cell(r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 @3xl/list:hidden" aria-label={label}>
        {rows.map((r) => (
          <li
            key={rowKey(r)}
            className={cn("flex gap-3 rounded-lg border p-3 text-sm", rowClassName?.(r))}
            data-row={rowKey(r)}
          >
            {cardLead?.(r)}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {first && <div className="font-medium">{first.cell(r)}</div>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {rest.map((c) => (
                  <div key={c.key} className="contents">
                    <dt className="text-muted-foreground">{c.header}</dt>
                    <dd className={cn("min-w-0", c.numeric && "tabular-nums")}>{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
