// =============================================
// File: src/pages/admin/AdminRoster.tsx
// Users & Pigeons management with search params
// =============================================
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useSearchParams } from "react-router-dom";
import {
  adminGetPigeons,
  adminUpdatePigeon,
  adminGetUsers,
  adminCreateUser,
  adminDeleteUser,
  adminUpdateUser,
} from "../../backend/fetch";
import { AdminPigeon, AdminUser } from "../../backend/types";

export default function AdminRoster() {
  const [sp, setSp] = useSearchParams();
  const [pigeons, setPigeons] = useState<AdminPigeon[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedPnParam = sp.get("pigeon");
  const selectedEmailParam = sp.get("user");

  const selectedPigeon = useMemo(() => {
    const pn = selectedPnParam ? Number(selectedPnParam) : undefined;
    return pn ? pigeons.find((p) => p.pigeon_number === pn) ?? null : null;
  }, [selectedPnParam, pigeons]);

  const selectedUser = useMemo(() => {
    return selectedEmailParam ? users.find((u) => u.email === selectedEmailParam) ?? null : null;
  }, [selectedEmailParam, users]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([adminGetPigeons(), adminGetUsers()])
      .then(([p, u]) => {
        setPigeons(p);
        setUsers(u);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const byPigeon = useMemo(() => {
    const primary: Record<number, string[]> = {}; // pn -> [emails]
    const secondary: Record<number, string[]> = {};
    for (const u of users) {
      if (u.primary_pigeon != null) {
        primary[u.primary_pigeon] ??= [];
        primary[u.primary_pigeon].push(u.email);
      }
      for (const pn of u.secondary_pigeons) {
        secondary[pn] ??= [];
        secondary[pn].push(u.email);
      }
    }
    return { primary, secondary };
  }, [users]);

  return (
    <Box>
      <Typography variant="body1" gutterBottom align="center" fontWeight={700}>
        Admin – Users & Pigeons
      </Typography>

      {loading && <Alert severity="info">Loading…</Alert>}
      {error && <Alert severity="error">{error}</Alert>}

      {!loading && !error && (
        <Stack direction={{ xs: "column", md: "row" }} spacing={3} alignItems="flex-start">
          <Box flex={1}>
            <PigeonsPanel
              pigeons={pigeons}
              users={users}
              byPigeon={byPigeon}
              selected={selectedPigeon}
              onSelect={(pn) => {
                const next = new URLSearchParams(sp);
                if (pn == null) next.delete("pigeon");
                else next.set("pigeon", String(pn));
                setSp(next, { replace: true });
              }}
              onPigeonChanged={(updated) => {
                setPigeons((arr) => arr.map((p) => (p.pigeon_number === updated.pigeon_number ? updated : p)));
              }}
              refreshUsers={async () => setUsers(await adminGetUsers())}
            />
          </Box>

          <Divider flexItem orientation="vertical" sx={{ display: { xs: "none", md: "block" } }} />

          <Box flex={1}>
            <UsersPanel
              pigeons={pigeons}
              users={users}
              selected={selectedUser}
              onSelect={(email) => {
                const next = new URLSearchParams(sp);
                if (!email) next.delete("user");
                else next.set("user", email);
                setSp(next, { replace: true });
              }}
              onUsersChanged={(nextUsers) => setUsers(nextUsers)}
            />
          </Box>
        </Stack>
      )}
    </Box>
  );
}

// -----------------------------
// PigeonsPanel
// -----------------------------
function PigeonsPanel({
  pigeons,
  users,
  byPigeon,
  selected,
  onSelect,
  onPigeonChanged,
  refreshUsers,
}: {
  pigeons: AdminPigeon[];
  users: AdminUser[];
  byPigeon: { primary: Record<number, string[]>; secondary: Record<number, string[]> };
  selected: AdminPigeon | null;
  onSelect: (pn: number | null) => void;
  onPigeonChanged: (p: AdminPigeon) => void;
  refreshUsers: () => Promise<void>;
}) {
  const [name, setName] = useState<string>(selected?.pigeon_name ?? "");
  const [ownerEmail, setOwnerEmail] = useState<string | null>(selected?.owner_email ?? null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setName(selected?.pigeon_name ?? "");
    setOwnerEmail(selected?.owner_email ?? null);
    setMsg(null);
    setErr(null);
  }, [selected]);

  const options = useMemo(() => pigeons.map((p) => ({ label: `${p.pigeon_number} – ${p.pigeon_name}`, pn: p.pigeon_number })), [pigeons]);

  const ownerOptions = useMemo(() => users.map((u) => ({ label: u.email, email: u.email })), [users]);

  const primaryList = selected ? byPigeon.primary[selected.pigeon_number] ?? [] : [];
  const secondaryList = selected ? byPigeon.secondary[selected.pigeon_number] ?? [] : [];

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Pigeons
      </Typography>

      <Autocomplete
        options={options}
        value={selected ? { label: `${selected.pigeon_number} – ${selected.pigeon_name}`, pn: selected.pigeon_number } : null}
        onChange={(_, v) => onSelect(v ? v.pn : null)}
        renderInput={(params) => <TextField {...params} label="Select pigeon" />}
        sx={{ mb: 2, maxWidth: 420 }}
      />

      {!selected && <Alert severity="info">Select a pigeon to manage.</Alert>}

      {selected && (
        <Stack spacing={2} maxWidth={520}>
          <TextField
            label="Pigeon name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <Autocomplete
            options={ownerOptions}
            value={ownerEmail ? { label: ownerEmail, email: ownerEmail } : null}
            onChange={(_, v) => setOwnerEmail(v?.email ?? null)}
            renderInput={(params) => <TextField {...params} label="Owner (optional)" helperText="Choose an existing user or leave unassigned" />}
          />

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              disabled={saving}
              onClick={async () => {
                if (!selected) return;
                setErr(null);
                setMsg(null);
                setSaving(true);
                try {
                  await adminUpdatePigeon(selected.pigeon_number, {
                    pigeon_name: name === selected.pigeon_name ? undefined : name,
                    owner_email: ownerEmail === selected.owner_email ? undefined : ownerEmail,
                  });
                  const updated: AdminPigeon = {
                    pigeon_number: selected.pigeon_number,
                    pigeon_name: name,
                    owner_email: ownerEmail,
                  };
                  onPigeonChanged(updated);
                  setMsg("Saved changes.");
                  // Owner changes affect user assignments; refresh users map
                  await refreshUsers();
                } catch (e: unknown) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save changes
            </Button>
            <Button
              variant="outlined"
              disabled={saving || !ownerEmail}
              onClick={async () => {
                if (!selected) return;
                setErr(null);
                setMsg(null);
                setSaving(true);
                try {
                  await adminUpdatePigeon(selected.pigeon_number, { owner_email: null });
                  onPigeonChanged({ ...selected, owner_email: null });
                  await refreshUsers();
                  setOwnerEmail(null);
                  setMsg("Owner unassigned.");
                } catch (e: unknown) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Unassign owner
            </Button>
          </Stack>

          {msg && <Alert severity="success">{msg}</Alert>}
          {err && <Alert severity="error">{err}</Alert>}

          <Box>
            <Typography variant="subtitle2" gutterBottom>Users with this pigeon as primary</Typography>
            {primaryList.length === 0 ? (
              <Typography variant="body2" color="text.secondary">None</Typography>
            ) : (
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                {primaryList.map((e) => (
                  <Chip key={e} label={e} size="small" />
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Users with this pigeon as secondary</Typography>
            {secondaryList.length === 0 ? (
              <Typography variant="body2" color="text.secondary">None</Typography>
            ) : (
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                {secondaryList.map((e) => (
                  <Chip key={e} label={e} size="small" />
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
    </Box>
  );
}

// -----------------------------
// UsersPanel
// -----------------------------
function UsersPanel({
  pigeons,
  users,
  selected,
  onSelect,
  onUsersChanged,
}: {
  pigeons: AdminPigeon[];
  users: AdminUser[];
  selected: AdminUser | null;
  onSelect: (email: string | null) => void;
  onUsersChanged: (users: AdminUser[]) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [primary, setPrimary] = useState<number | null>(selected?.primary_pigeon ?? null);
  const [secondary, setSecondary] = useState<number[]>(selected?.secondary_pigeons ?? []);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setPrimary(selected?.primary_pigeon ?? null);
    setSecondary(selected?.secondary_pigeons ?? []);
    setMsg(null);
    setErr(null);
  }, [selected]);

  const userOptions = useMemo(() => users.map((u) => ({ label: u.email, email: u.email })), [users]);
  const pigeonOptions = useMemo(
    () => pigeons.map((p) => ({ label: `${p.pigeon_number} – ${p.pigeon_name}`, pn: p.pigeon_number })),
    [pigeons]
  );

  const secondaryOptions = useMemo(() => {
    const exclude = new Set<number>();
    if (primary != null) exclude.add(primary);
    return pigeonOptions.filter((o) => !exclude.has(o.pn));
  }, [pigeonOptions, primary]);

  // Typed "None" option to avoid `as any`
  const noneOption: { label: string; pn: number | null } = { label: "None", pn: null };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Users
      </Typography>

      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Autocomplete
          options={userOptions}
          value={selected ? { label: selected.email, email: selected.email } : null}
          onChange={(_, v) => onSelect(v?.email ?? null)}
          renderInput={(params) => <TextField {...params} label="Select user" />}
          sx={{ minWidth: 320 }}
        />
        <Button variant="outlined" onClick={() => setCreateOpen(true)}>
          Add new user
        </Button>
      </Stack>

      {!selected && <Alert severity="info">Select a user to manage, or add a new one.</Alert>}

      {selected && (
        <Stack spacing={2} maxWidth={520}>
          <Autocomplete
            options={[noneOption, ...pigeonOptions]}
            value={
              primary == null
                ? noneOption
                : pigeonOptions.find((o) => o.pn === primary) ?? null
            }
            onChange={(_, v) => setPrimary(v?.pn ?? null)}
            renderInput={(params) => <TextField {...params} label="Primary pigeon" />}
          />

          <Autocomplete
            multiple
            options={secondaryOptions}
            value={secondary.map((pn) => secondaryOptions.find((o) => o.pn === pn)!).filter(Boolean)}
            onChange={(_, v) => setSecondary(v.map((o) => o.pn))}
            renderInput={(params) => <TextField {...params} label="Secondary pigeons" />}
          />

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              disabled={saving}
              onClick={async () => {
                if (!selected) return;
                setErr(null);
                setMsg(null);
                setSaving(true);
                try {
                  await adminUpdateUser(selected.email, {
                    primary_pigeon: primary,
                    secondary_pigeons: secondary ?? [],
                  });
                  // Update local cache without full refetch
                  const next = users.map((u) =>
                    u.email === selected.email
                      ? { ...u, primary_pigeon: primary, secondary_pigeons: [...(secondary ?? [])] }
                      : u
                  );
                  onUsersChanged(next);
                  setMsg("Saved changes.");
                } catch (e: unknown) {
                  setErr(e instanceof Error ? e.message : String(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Save changes
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={saving}
              onClick={async () => {
                if (!selected) return;
                const ok = confirm(`Delete user ${selected.email}?`);
                if (!ok) return;
                setErr(null);
                setMsg(null);
                setSaving(true);
                try {
                  await adminDeleteUser(selected.email);
                  const next = users.filter((u) => u.email !== selected.email);
                  onUsersChanged(next);
                  onSelect(null);
                  setMsg("User deleted.");
                } catch (e: unknown) {
                  if (String((e as Error | string) instanceof Error ? (e as Error).message : e).includes("owns pigeon")) {
                    setErr(String((e as Error | string) instanceof Error ? (e as Error).message : e));
                  } else {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                } finally {
                  setSaving(false);
                }
              }}
            >
              Delete user
            </Button>
          </Stack>

          {msg && <Alert severity="success">{msg}</Alert>}
          {err && <Alert severity="error">{err}</Alert>}
        </Stack>
      )}

      {/* Create user dialog */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <DialogTitle>Create user</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Email"
            type="email"
            fullWidth
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={async () => {
              try {
                const nu = await adminCreateUser({ email: newEmail.trim() });
                const next = [...users, nu].sort((a, b) => a.email.localeCompare(b.email));
                onUsersChanged(next);
                setCreateOpen(false);
                setNewEmail("");
                // Select the new user in URL
                onSelect(nu.email);
              } catch (e: unknown) {
                alert(e instanceof Error ? e.message : String(e));
              }
            }}
            disabled={!newEmail}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
