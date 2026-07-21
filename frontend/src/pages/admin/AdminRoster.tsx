import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import {
  adminCreatePigeon,
  adminDeletePigeon,
  adminGetPigeons,
  adminSendBulkEmail,
  adminUpdatePigeon,
  getCurrentWeek,
} from "../../backend/fetch";
import type {
  AdminPigeon,
  AdminPigeonCreateIn,
  AdminPigeonUpdateIn,
  PigeonSeasonStatus,
} from "../../backend/types";
import { AppSnackbar, type Severity } from "../../components/CommonComponents";

type RosterFormState =
  | { mode: "create" }
  | { mode: "edit"; pigeon: AdminPigeon };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

function dedupeEmails(emails: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const rawEmail of emails) {
    const email = rawEmail.trim();
    if (email && !byKey.has(emailKey(email))) byKey.set(emailKey(email), email);
  }
  return [...byKey.values()];
}

function sortedRoster(pigeons: AdminPigeon[]): AdminPigeon[] {
  return [...pigeons].sort((a, b) => a.pigeon_number - b.pigeon_number);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ManagersSummary({ pigeon }: { pigeon: AdminPigeon }) {
  if (!pigeon.owner) {
    return (
      <Typography component="span" variant="body2" color="error.main" fontWeight={600}>
        Owner required
      </Typography>
    );
  }

  const count = pigeon.managers.length;
  return (
    <Typography component="span" variant="body2">
      {pigeon.owner.email}
      {count > 0 ? ` + ${count} ${count === 1 ? "other" : "others"}` : ""}
    </Typography>
  );
}

function StatusChip({ status }: { status: PigeonSeasonStatus }) {
  const label = status[0].toUpperCase() + status.slice(1);
  const color = status === "active" ? "success" : status === "pending" ? "warning" : "default";
  return <Chip size="small" label={label} color={color} variant="outlined" />;
}

export default function AdminRoster() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  const [pigeons, setPigeons] = useState<AdminPigeon[]>([]);
  const [seasonStarted, setSeasonStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formState, setFormState] = useState<RosterFormState | null>(null);
  const [deletePigeon, setDeletePigeon] = useState<AdminPigeon | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: Severity;
  }>({ open: false, message: "", severity: "info" });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([adminGetPigeons(), getCurrentWeek()])
      .then(([roster, currentWeek]) => {
        if (cancelled) return;
        setPigeons(sortedRoster(roster));
        setSeasonStarted(currentWeek.any_locked);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const leagueEmails = useMemo(() => {
    const emails: string[] = [];
    for (const pigeon of pigeons) {
      if (pigeon.owner) emails.push(pigeon.owner.email);
      emails.push(...pigeon.managers.map((manager) => manager.email));
    }
    return dedupeEmails(emails).sort((a, b) => a.localeCompare(b));
  }, [pigeons]);

  const showSnackbar = (message: string, severity: Severity) => {
    setSnackbar({ open: true, message, severity });
  };

  const upsertPigeon = (updated: AdminPigeon) => {
    setPigeons((current) => {
      const exists = current.some((pigeon) => pigeon.player_id === updated.player_id);
      return sortedRoster(
        exists
          ? current.map((pigeon) => (pigeon.player_id === updated.player_id ? updated : pigeon))
          : [...current, updated],
      );
    });
  };

  const rowActions = (pigeon: AdminPigeon) => (
    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
      <Button
        size="small"
        onClick={() => setFormState({ mode: "edit", pigeon })}
        aria-label={`Edit pigeon #${pigeon.pigeon_number}`}
      >
        Edit
      </Button>
      {!seasonStarted && (
        <Button
          size="small"
          color="error"
          onClick={() => setDeletePigeon(pigeon)}
          aria-label={`Delete pigeon #${pigeon.pigeon_number}`}
        >
          Delete
        </Button>
      )}
    </Stack>
  );

  return (
    <Box sx={{ px: { xs: 1.5, sm: 3 }, pb: 4 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        alignItems={{ xs: "stretch", sm: "center" }}
        justifyContent="space-between"
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h5" component="h1">
            Roster
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage pigeons and the people assigned to them.
          </Typography>
        </Box>
        {!seasonStarted && (
          <Button variant="contained" onClick={() => setFormState({ mode: "create" })}>
            New pigeon
          </Button>
        )}
      </Stack>

      {seasonStarted && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The season has started. Pigeons can be edited, but they cannot be added or deleted.
        </Alert>
      )}
      {loading && <Alert severity="info">Loading roster…</Alert>}
      {loadError && <Alert severity="error">{loadError}</Alert>}

      {!loading && !loadError && isMobile && (
        <Stack spacing={1.5}>
          {pigeons.length === 0 && <Alert severity="info">No pigeons have been added yet.</Alert>}
          {pigeons.map((pigeon) => (
            <Card key={pigeon.player_id} variant="outlined">
              <CardContent sx={{ pb: 1 }}>
                <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="flex-start">
                  <Box>
                    <Typography variant="overline" color="text.secondary">
                      Pigeon #{pigeon.pigeon_number}
                    </Typography>
                    <Typography variant="h6" sx={{ overflowWrap: "anywhere" }}>
                      {pigeon.pigeon_name}
                    </Typography>
                  </Box>
                  <StatusChip status={pigeon.season_status} />
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                  Managers
                </Typography>
                <Box sx={{ overflowWrap: "anywhere" }}>
                  <ManagersSummary pigeon={pigeon} />
                </Box>
              </CardContent>
              <CardActions sx={{ justifyContent: "flex-end", pt: 0 }}>
                {rowActions(pigeon)}
              </CardActions>
            </Card>
          ))}
        </Stack>
      )}

      {!loading && !loadError && !isMobile && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="Pigeon roster">
            <TableHead>
              <TableRow>
                <TableCell align="right" sx={{ width: 72 }}>Number</TableCell>
                <TableCell>Pigeon name</TableCell>
                <TableCell>Managers</TableCell>
                <TableCell sx={{ width: 110 }}>Status</TableCell>
                <TableCell align="right" sx={{ width: 150 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pigeons.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">
                    No pigeons have been added yet.
                  </TableCell>
                </TableRow>
              ) : (
                pigeons.map((pigeon) => (
                  <TableRow key={pigeon.player_id} hover>
                    <TableCell align="right">{pigeon.pigeon_number}</TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere" }}>{pigeon.pigeon_name}</TableCell>
                    <TableCell sx={{ overflowWrap: "anywhere" }}>
                      <ManagersSummary pigeon={pigeon} />
                    </TableCell>
                    <TableCell><StatusChip status={pigeon.season_status} /></TableCell>
                    <TableCell align="right">{rowActions(pigeon)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <BulkEmailAnnouncement onSnackbar={showSnackbar} />

      {formState && (
        <PigeonFormDialog
          key={formState.mode === "edit" ? `edit-${formState.pigeon.player_id}` : "create"}
          pigeon={formState.mode === "edit" ? formState.pigeon : undefined}
          leagueEmails={leagueEmails}
          fullScreen={isMobile}
          onClose={() => setFormState(null)}
          onSaved={(pigeon, created) => {
            upsertPigeon(pigeon);
            setFormState(null);
            showSnackbar(created ? "Pigeon created." : "Changes saved.", "success");
          }}
        />
      )}

      {deletePigeon && (
        <DeletePigeonDialog
          pigeon={deletePigeon}
          onClose={() => setDeletePigeon(null)}
          onDeleted={(playerId) => {
            setPigeons((current) => current.filter((pigeon) => pigeon.player_id !== playerId));
            setDeletePigeon(null);
            showSnackbar("Pigeon deleted.", "success");
          }}
        />
      )}

      <AppSnackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar((current) => ({ ...current, open: false }))}
      />
    </Box>
  );
}

function PigeonFormDialog({
  pigeon,
  leagueEmails,
  fullScreen,
  onClose,
  onSaved,
}: {
  pigeon?: AdminPigeon;
  leagueEmails: string[];
  fullScreen: boolean;
  onClose: () => void;
  onSaved: (pigeon: AdminPigeon, created: boolean) => void;
}) {
  const editing = pigeon !== undefined;
  const [name, setName] = useState(pigeon?.pigeon_name ?? "");
  const [status, setStatus] = useState<PigeonSeasonStatus>(pigeon?.season_status ?? "pending");
  const [ownerEmail, setOwnerEmail] = useState(pigeon?.owner?.email ?? "");
  const [managerEmails, setManagerEmails] = useState<string[]>(
    pigeon?.managers.map((manager) => manager.email) ?? [],
  );
  const [managerDraft, setManagerDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const ownerKey = emailKey(ownerEmail);
  const managerOptions = leagueEmails.filter((email) => emailKey(email) !== ownerKey);

  const handleOwnerChange = (nextOwner: string) => {
    setOwnerEmail(nextOwner);
    const nextKey = emailKey(nextOwner);
    setManagerEmails((current) => current.filter((email) => emailKey(email) !== nextKey));
    if (emailKey(managerDraft) === nextKey) setManagerDraft("");
    setSaveError(null);
  };

  const handleSubmit = async () => {
    const pigeonName = name.trim();
    const owner = ownerEmail.trim();
    const managers = dedupeEmails([...managerEmails, managerDraft]).filter(
      (email) => emailKey(email) !== emailKey(owner),
    );

    if (!pigeonName) {
      setSaveError("Pigeon name is required.");
      return;
    }
    if (!EMAIL_PATTERN.test(owner)) {
      setSaveError("Enter a valid owner email address.");
      return;
    }
    const invalidManager = managers.find((email) => !EMAIL_PATTERN.test(email));
    if (invalidManager) {
      setSaveError(`Enter a valid manager email address: ${invalidManager}`);
      return;
    }

    const input: AdminPigeonCreateIn | AdminPigeonUpdateIn = {
      pigeon_name: pigeonName,
      season_status: status,
      owner_email: owner,
      manager_emails: managers,
    };

    setSaving(true);
    setSaveError(null);
    try {
      const saved = editing
        ? await adminUpdatePigeon(pigeon.player_id, input)
        : await adminCreatePigeon(input);
      onSaved(saved, !editing);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreen}
    >
      <DialogTitle>{editing ? `Edit pigeon #${pigeon.pigeon_number}` : "New pigeon"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {editing && (
            <TextField label="Pigeon number" value={pigeon.pigeon_number} disabled fullWidth />
          )}
          <TextField
            autoFocus
            label="Pigeon name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaveError(null);
            }}
            required
            fullWidth
            disabled={saving}
          />
          <FormControl fullWidth disabled={saving}>
            <InputLabel>Season status</InputLabel>
            <Select
              label="Season status"
              value={status}
              onChange={(event) => setStatus(event.target.value as PigeonSeasonStatus)}
            >
              <MenuItem value="pending">Pending</MenuItem>
              <MenuItem value="active">Active</MenuItem>
              <MenuItem value="out">Out</MenuItem>
            </Select>
          </FormControl>
          <Autocomplete
            freeSolo
            options={leagueEmails}
            value={ownerEmail || null}
            inputValue={ownerEmail}
            onChange={(_, value) => handleOwnerChange(value ?? "")}
            onInputChange={(_, value) => handleOwnerChange(value)}
            disabled={saving}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Owner email"
                type="email"
                required
                helperText={
                  editing
                    ? "Changing the owner removes the former owner unless you add them below."
                    : "The person will be added to this league if needed."
                }
              />
            )}
          />
          <Autocomplete
            multiple
            freeSolo
            options={managerOptions}
            value={managerEmails}
            inputValue={managerDraft}
            onChange={(_, values) => {
              setManagerEmails(
                dedupeEmails(values).filter((email) => emailKey(email) !== emailKey(ownerEmail)),
              );
              setSaveError(null);
            }}
            onInputChange={(_, value) => setManagerDraft(value)}
            disabled={saving}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Additional manager emails"
                helperText="Optional. Press Enter after each email."
              />
            )}
          />
          {saveError && <Alert severity="error">{saveError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={saving || !name.trim() || !ownerEmail.trim()}
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Create pigeon"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DeletePigeonDialog({
  pigeon,
  onClose,
  onDeleted,
}: {
  pigeon: AdminPigeon;
  onClose: () => void;
  onDeleted: (playerId: number) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const assignedPeople = [pigeon.owner, ...pigeon.managers].filter(
    (person): person is NonNullable<typeof person> => person !== null,
  );
  const accessCount = assignedPeople.length;
  const primaryCount = assignedPeople.filter((person) => person.is_primary).length;

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await adminDeletePigeon(pigeon.player_id);
      onDeleted(pigeon.player_id);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open onClose={deleting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Delete pigeon?</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <Typography>
            Delete pigeon #{pigeon.pigeon_number}, {pigeon.pigeon_name}?
          </Typography>
          <Typography variant="body2">
            This permanently deletes the pigeon and any picks recorded for it.
          </Typography>
          {accessCount > 0 && (
            <Typography variant="body2">
              This removes access for {accessCount} {accessCount === 1 ? "person" : "people"}.
              {primaryCount > 0
                ? ` ${primaryCount === 1
                  ? "One person's primary pigeon"
                  : `The primary pigeon for ${primaryCount} people`} will change automatically.`
                : ""}
            </Typography>
          )}
          {deleteError && <Alert severity="error">{deleteError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>Cancel</Button>
        <Button variant="contained" color="error" onClick={handleDelete} disabled={deleting}>
          {deleting ? "Deleting…" : "Delete pigeon"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function BulkEmailAnnouncement({
  onSnackbar,
}: {
  onSnackbar: (message: string, severity: Severity) => void;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const close = () => {
    setOpen(false);
    setSubject("");
    setMessage("");
    setResult(null);
    setSending(false);
  };

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      await adminSendBulkEmail({ subject: subject.trim(), text: message.trim() });
      setResult({ success: true, message: "Announcement sent to all users." });
      onSnackbar("Announcement sent.", "success");
    } catch (error) {
      const detail = errorMessage(error);
      setResult({ success: false, message: detail });
      onSnackbar(detail, "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <Box sx={{ mt: 5, textAlign: "center" }}>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        Send email announcement
      </Button>
      <Dialog open={open} onClose={sending ? undefined : close} maxWidth="sm" fullWidth>
        <DialogTitle>Send email announcement</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              label="Subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={sending || result !== null}
              fullWidth
            />
            <TextField
              label="Message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              disabled={sending || result !== null}
              multiline
              minRows={5}
              fullWidth
            />
            {result && <Alert severity={result.success ? "success" : "error"}>{result.message}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          {result ? (
            <Button variant="contained" onClick={close}>Dismiss</Button>
          ) : (
            <>
              <Button onClick={close} disabled={sending}>Cancel</Button>
              <Button
                variant="contained"
                onClick={send}
                disabled={sending || !subject.trim() || !message.trim()}
              >
                {sending ? "Sending…" : "Send"}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
