"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

/**
 * List search (04-ui-ux §4.1): debounced 200 ms. Marked with `data-list-search` so the `/` shortcut focuses it.
 */
export function ListSearch({
  label,
  placeholder,
  defaultValue = "",
  onSearch,
  delayMs = 200,
}: {
  label: string;
  placeholder?: string;
  defaultValue?: string;
  onSearch: (value: string) => void;
  delayMs?: number;
}) {
  const [value, setValue] = useState(defaultValue);
  const callback = useRef(onSearch);
  callback.current = onSearch;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const id = setTimeout(() => callback.current(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return (
    <InputGroup className="max-w-sm">
      <InputGroupInput
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        data-list-search=""
        onChange={(e) => setValue(e.target.value)}
      />
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
    </InputGroup>
  );
}
