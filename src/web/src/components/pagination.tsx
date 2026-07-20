import { Button } from "./ui/button";

export interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onPage: (offset: number) => void;
  /** Noun for the count line, e.g. "assets". */
  noun: string;
}

/** Prev/next pager for server-side paginated lists. */
export function Pagination({
  total,
  limit,
  offset,
  onPage,
  noun,
}: PaginationProps) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="mt-4 flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground">
        {total === 0
          ? `No ${noun}`
          : `Showing ${from}-${to} of ${total} ${noun}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onPage(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + limit >= total}
          onClick={() => onPage(offset + limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
