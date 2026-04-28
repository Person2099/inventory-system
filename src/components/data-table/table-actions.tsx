import { AddDialog } from "@/components/data-table/add-dialog";
import { BulkActions } from "@/components/data-table/bulk-actions";
import type { Table } from "@tanstack/react-table";
import type { CartItem } from "@/contexts/cart-context";

interface TableActionsProps<TData extends Omit<CartItem, "quantity">> {
  table: Table<TData>;
  onRefetch?: () => void;
  defaultConsumable?: boolean;
  isAdmin?: boolean;
}

export function TableActions<TData extends Omit<CartItem, "quantity">>({
  table,
  onRefetch,
  defaultConsumable,
  isAdmin,
}: TableActionsProps<TData>) {
  return (
    <div className="flex items-center gap-2">
      <BulkActions table={table} onRefetch={onRefetch} />
      {isAdmin && <AddDialog defaultConsumable={defaultConsumable} />}
    </div>
  );
}
