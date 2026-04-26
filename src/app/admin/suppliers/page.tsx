"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TruckIcon, PlusCircleIcon, ArchiveIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";

type FormState = {
  name: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
};

const EMPTY: FormState = { name: "", contactEmail: "", contactPhone: "", notes: "" };

export default function SuppliersPage() {
  const trpc = useTRPC();
  const listQuery = useQuery(trpc.suppliers.list.queryOptions());
  const listKey = trpc.suppliers.list.queryOptions().queryKey;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  const createMutation = useCrudMutation({
    mutationOptions: trpc.suppliers.create.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Supplier created",
    errorMessage: "Failed to create supplier",
    onSuccess: () => {
      setForm(EMPTY);
      setDialogOpen(false);
    },
  });

  const archiveMutation = useCrudMutation({
    mutationOptions: trpc.suppliers.archive.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Supplier archived",
    errorMessage: "Failed to archive supplier",
  });

  const submit = () => {
    if (!form.name.trim()) return;
    createMutation.mutate({
      name: form.name.trim(),
      contactEmail: form.contactEmail.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
  };

  const suppliers = listQuery.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <TruckIcon className="w-5 h-5" />
          <CardTitle>Suppliers</CardTitle>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <PlusCircleIcon className="w-4 h-4 mr-2" /> New supplier
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppliers.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{s.contact_email ?? "—"}</TableCell>
                <TableCell>{s.contact_phone ?? "—"}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => archiveMutation.mutate({ id: s.id })}
                    disabled={archiveMutation.isPending}
                  >
                    <ArchiveIcon className="w-4 h-4 mr-2" /> Archive
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {suppliers.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  No suppliers yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New supplier</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.contactEmail}
                onChange={(e) =>
                  setForm((s) => ({ ...s, contactEmail: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Phone</Label>
              <Input
                value={form.contactPhone}
                onChange={(e) =>
                  setForm((s) => ({ ...s, contactPhone: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Notes</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={createMutation.isPending}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
