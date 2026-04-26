"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  UsersRoundIcon,
  PlusCircleIcon,
  ArchiveIcon,
  CopyIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc/client";
import { useCrudMutation } from "@/hooks/use-crud-mutation";

type Role = "owner" | "manager" | "cashier" | "artist" | "viewer";
type ScopeKind = "business" | "location";

interface FormState {
  email: string;
  displayName: string;
  role: Role;
  scopeKind: ScopeKind;
  locationId: string;
}

const EMPTY_FORM: FormState = {
  email: "",
  displayName: "",
  role: "cashier",
  scopeKind: "business",
  locationId: "",
};

const ROLE_OPTIONS: Role[] = [
  "owner",
  "manager",
  "cashier",
  "artist",
  "viewer",
];

export default function TeamPage() {
  const trpc = useTRPC();
  const businessQuery = useQuery(trpc.businesses.getCurrent.queryOptions());
  const role = businessQuery.data?.role ?? null;
  const isAuthorized = role === "owner" || role === "manager";

  const listOptions = trpc.team.list.queryOptions(undefined, {
    enabled: isAuthorized,
  });
  const listQuery = useQuery(listOptions);
  const listKey = trpc.team.list.queryOptions().queryKey;
  const locationsQuery = useQuery(trpc.locations.list.queryOptions());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(
    null,
  );

  const inviteMutation = useCrudMutation({
    mutationOptions: trpc.team.invite.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Member invited",
    errorMessage: "Failed to invite member",
    onSuccess: (data) => {
      setForm(EMPTY_FORM);
      setDialogOpen(false);
      if (data.generatedPassword) {
        setGeneratedPassword(data.generatedPassword);
      }
    },
  });

  const updateRoleMutation = useCrudMutation({
    mutationOptions: trpc.team.updateRole.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Role updated",
    errorMessage: "Failed to update role",
  });

  const archiveMutation = useCrudMutation({
    mutationOptions: trpc.team.archive.mutationOptions(),
    invalidateKeys: listKey,
    successMessage: "Member removed",
    errorMessage: "Failed to remove member",
  });

  if (!businessQuery.isLoading && !isAuthorized) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            You don&apos;t have permission to manage the team. Contact an owner
            or manager.
          </p>
        </CardContent>
      </Card>
    );
  }

  const submit = () => {
    if (!form.email.trim() || !form.displayName.trim()) return;
    if (form.scopeKind === "location" && !form.locationId) {
      toast.error("Select a location for the granular scope");
      return;
    }
    inviteMutation.mutate({
      email: form.email.trim(),
      displayName: form.displayName.trim(),
      role: form.role,
      scope:
        form.scopeKind === "business"
          ? { kind: "business" }
          : { kind: "location", locationId: Number(form.locationId) },
    });
  };

  const members = listQuery.data ?? [];
  const locations = locationsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <UsersRoundIcon className="w-5 h-5" />
            <CardTitle>Team</CardTitle>
          </div>
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <PlusCircleIcon className="w-4 h-4 mr-2" /> Invite member
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={`${m.type}-${m.membershipId}`}>
                  <TableCell className="font-medium">{m.email}</TableCell>
                  <TableCell>{m.name}</TableCell>
                  <TableCell>
                    <Select
                      value={m.role}
                      onValueChange={(v) =>
                        updateRoleMutation.mutate({
                          membershipId: m.membershipId,
                          type: m.type,
                          role: v as Role,
                        })
                      }
                    >
                      <SelectTrigger className="w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {m.type === "business" ? (
                      <Badge variant="default">Business-wide</Badge>
                    ) : (
                      <Badge variant="secondary">
                        {m.locationName ?? `Location ${m.locationId}`}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{m.status}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        archiveMutation.mutate({
                          membershipId: m.membershipId,
                          type: m.type,
                        })
                      }
                      disabled={archiveMutation.isPending}
                    >
                      <ArchiveIcon className="w-4 h-4 mr-2" /> Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {members.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground"
                  >
                    No members yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid gap-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((s) => ({ ...s, email: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Display name</Label>
              <Input
                value={form.displayName}
                onChange={(e) =>
                  setForm((s) => ({ ...s, displayName: e.target.value }))
                }
              />
            </div>
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select
                value={form.role}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, role: v as Role }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Scope</Label>
              <Select
                value={form.scopeKind}
                onValueChange={(v) =>
                  setForm((s) => ({ ...s, scopeKind: v as ScopeKind }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="business">
                    Business-wide (all locations)
                  </SelectItem>
                  <SelectItem value="location">
                    Specific location only
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.scopeKind === "location" && (
              <div className="grid gap-2">
                <Label>Location</Label>
                <Select
                  value={form.locationId}
                  onValueChange={(v) =>
                    setForm((s) => ({ ...s, locationId: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={inviteMutation.isPending}>
              Invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={generatedPassword !== null}
        onOpenChange={(open) => {
          if (!open) setGeneratedPassword(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>One-time password</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Share this password with the new member. It will not be shown
            again. The member should change it on first login.
          </p>
          <div className="flex items-center gap-2">
            <Input readOnly value={generatedPassword ?? ""} />
            <Button
              size="icon"
              variant="outline"
              onClick={() => {
                if (generatedPassword) {
                  navigator.clipboard.writeText(generatedPassword);
                  toast.success("Password copied");
                }
              }}
            >
              <CopyIcon className="w-4 h-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setGeneratedPassword(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
