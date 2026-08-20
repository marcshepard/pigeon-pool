import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  Menu,
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
  Tooltip,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import {
  adminCreatePigeon,
  adminDeletePigeon,
  adminGetPigeons,
  adminSendBulkEmail,
  adminUpdatePigeon,
  getCurrentWeek,
} from "../../backend/fetch";
import { useAuth } from "../../auth/useAuth";
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const ROSTER_COLUMNS_STORAGE_PREFIX = "pigeonpool.adminRoster.columns";

type RosterColumnVisibility = {
  notes: boolean;
  status: boolean;
};

const DEFAULT_COLUMN_VISIBILITY: RosterColumnVisibility = {
  notes: true,
  status: true,
};

function loadColumnVisibility(tenantId: number): RosterColumnVisibility {
  try {
    const raw = localStorage.getItem(`${ROSTER_COLUMNS_STORAGE_PREFIX}.${tenantId}`);
    if (!raw) return DEFAULT_COLUMN_VISIBILITY;
    const saved = JSON.parse(raw) as Partial<RosterColumnVisibility>;
    return {
      notes: typeof saved.notes === "boolean" ? saved.notes : true,
      status: typeof saved.status === "boolean" ? saved.status : true,
    };
  } catch {
    return DEFAULT_COLUMN_VISIBILITY;
  }
}

function saveColumnVisibility(tenantId: number, visibility: RosterColumnVisibility): void {
  try {
    localStorage.setItem(
      `${ROSTER_COLUMNS_STORAGE_PREFIX}.${tenantId}`,
      JSON.stringify(visibility),
    );
  } catch {
    // The current view still updates when browser storage is unavailable.
  }
}

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

function notePreview(note: string): string {
  const singleLine = note.replace(/\s+/g, " ").trim();
  return singleLine.length > 20 ? `${singleLine.slice(0, 20)}…` : singleLine;
}

function ManagersSummary({ pigeon }: { pigeon: AdminPigeon }) {
  if (!pigeon.owner) {
    const count = pigeon.managers.length;
    return (
      <Typography component="span" variant="body2" color="text.secondary">
        {count > 0
          ? `${count} ${count === 1 ? "manager" : "managers"} (no owner)`
          : "Not using the app"}
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
  const { me } = useAuth();
  const tenantId = me?.tenant_id;
  const [pigeons, setPigeons] = useState<AdminPigeon[]>([]);
  const [seasonStarted, setSeasonStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formState, setFormState] = useState<RosterFormState | null>(null);
  const [deletePigeon, setDeletePigeon] = useState<AdminPigeon | null>(null);
  const [columnMenuAnchor, setColumnMenuAnchor] = useState<HTMLElement | null>(null);
  const [columnVisibility, setColumnVisibility] = useState<RosterColumnVisibility>(
    DEFAULT_COLUMN_VISIBILITY,
  );
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

  useEffect(() => {
    if (tenantId === undefined) return;
    setColumnVisibility(loadColumnVisibility(tenantId));
  }, [tenantId]);

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

  const toggleColumn = (column: keyof RosterColumnVisibility) => {
    const next = { ...columnVisibility, [column]: !columnVisibility[column] };
    setColumnVisibility(next);
    if (tenantId !== undefined) saveColumnVisibility(tenantId, next);
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

  const copyNote = async (pigeon: AdminPigeon) => {
    try {
      await navigator.clipboard.writeText(pigeon.commissioner_notes);
      showSnackbar("Note copied.", "success");
    } catch (error) {
      showSnackbar(`Could not copy note: ${errorMessage(error)}`, "error");
    }
  };

  const noteSummary = (pigeon: AdminPigeon) => {
    if (!pigeon.commissioner_notes) {
      return <Typography color="text.secondary">—</Typography>;
    }
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="body2" noWrap title={pigeon.commissioner_notes}>
          {notePreview(pigeon.commissioner_notes)}
        </Typography>
        <Tooltip title="Copy full note">
          <IconButton
            size="small"
            aria-label={`Copy note for pigeon #${pigeon.pigeon_number}`}
            onClick={() => void copyNote(pigeon)}
          >
            <ContentCopyIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      </Stack>
    );
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
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            variant="outlined"
            startIcon={<ViewColumnIcon />}
            onClick={(event) => setColumnMenuAnchor(event.currentTarget)}
            aria-controls={columnMenuAnchor ? "roster-columns-menu" : undefined}
            aria-haspopup="true"
            aria-expanded={columnMenuAnchor ? "true" : undefined}
          >
            Columns
          </Button>
          {!seasonStarted && (
            <Button variant="contained" onClick={() => setFormState({ mode: "create" })}>
              New pigeon
            </Button>
          )}
        </Stack>
      </Stack>

      <Menu
        id="roster-columns-menu"
        anchorEl={columnMenuAnchor}
        open={Boolean(columnMenuAnchor)}
        onClose={() => setColumnMenuAnchor(null)}
      >
        <MenuItem dense onClick={() => toggleColumn("notes")}>
          <Checkbox checked={columnVisibility.notes} size="small" disableRipple sx={{ p: 0, mr: 1 }} />
          Notes
        </MenuItem>
        <MenuItem dense onClick={() => toggleColumn("status")}>
          <Checkbox checked={columnVisibility.status} size="small" disableRipple sx={{ p: 0, mr: 1 }} />
          Status
        </MenuItem>
      </Menu>

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
                  {columnVisibility.status && <StatusChip status={pigeon.season_status} />}
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                  Managers
                </Typography>
                <Box sx={{ overflowWrap: "anywhere" }}>
                  <ManagersSummary pigeon={pigeon} />
                </Box>
                {columnVisibility.notes && pigeon.commissioner_notes && (
                  <>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                      Notes
                    </Typography>
                    {noteSummary(pigeon)}
                  </>
                )}
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
                {columnVisibility.notes && <TableCell sx={{ minWidth: 220 }}>Notes</TableCell>}
                {columnVisibility.status && <TableCell sx={{ width: 110 }}>Status</TableCell>}
                <TableCell align="right" sx={{ width: 150 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pigeons.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4 + Number(columnVisibility.notes) + Number(columnVisibility.status)}
                    align="center"
                  >
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
                    {columnVisibility.notes && (
                      <TableCell sx={{ maxWidth: 260 }}>{noteSummary(pigeon)}</TableCell>
                    )}
                    {columnVisibility.status && (
                      <TableCell><StatusChip status={pigeon.season_status} /></TableCell>
                    )}
                    <TableCell align="right">{rowActions(pigeon)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="center"
        alignItems="center"
        sx={{ mt: 5 }}
      >
        <CopyEmailAddresses pigeons={pigeons} />
        <BulkEmailAnnouncement onSnackbar={showSnackbar} />
      </Stack>

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
  const [notes, setNotes] = useState(pigeon?.commissioner_notes ?? "");
  const [managerDraft, setManagerDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleOwnerChange = (nextOwner: string) => {
    setOwnerEmail(nextOwner);
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
    if (owner && !EMAIL_PATTERN.test(owner)) {
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
      owner_email: owner || null,
      manager_emails: managers,
      commissioner_notes: notes.trim(),
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
                helperText="Optional. Assigning an owner gives that person app access."
              />
            )}
          />
          <Autocomplete
            multiple
            freeSolo
            options={leagueEmails}
            value={managerEmails}
            inputValue={managerDraft}
            onChange={(_, values) => {
              setManagerEmails(dedupeEmails(values));
              setSaveError(null);
            }}
            onInputChange={(_, value) => setManagerDraft(value)}
            disabled={saving}
            slotProps={{
              chip: {
                onMouseDown: (event: MouseEvent<HTMLDivElement>) => event.stopPropagation(),
                onClick: (event: MouseEvent<HTMLDivElement>) => event.stopPropagation(),
                sx: { "& .MuiChip-label": { userSelect: "text", cursor: "text" } },
              },
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Additional manager emails"
                helperText="Optional. Press Enter after each email."
              />
            )}
          />
          <TextField
            label="Notes"
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
              setSaveError(null);
            }}
            helperText="Only commissioners can see these notes."
            multiline
            minRows={3}
            slotProps={{ htmlInput: { maxLength: 2000 } }}
            disabled={saving}
            fullWidth
          />
          {saveError && <Alert severity="error">{saveError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={saving || !name.trim()}
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

function emailsForFilters(
  pigeons: AdminPigeon[],
  status: PigeonSeasonStatus | "all",
  ownersOnly: boolean,
  excludeEmail: string | undefined,
): string[] {
  const emails: string[] = [];
  for (const pigeon of pigeons) {
    if (status !== "all" && pigeon.season_status !== status) continue;
    if (pigeon.owner) emails.push(pigeon.owner.email);
    if (!ownersOnly) emails.push(...pigeon.managers.map((manager) => manager.email));
  }
  let result = dedupeEmails(emails);
  if (excludeEmail) {
    result = result.filter((email) => emailKey(email) !== emailKey(excludeEmail));
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function CopyEmailAddresses({ pigeons }: { pigeons: AdminPigeon[] }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PigeonSeasonStatus | "all">("all");
  const [ownersOnly, setOwnersOnly] = useState(false);
  const [includeSelf, setIncludeSelf] = useState(false);
  const [copied, setCopied] = useState(false);

  const emails = useMemo(
    () => emailsForFilters(pigeons, status, ownersOnly, includeSelf ? undefined : me?.email),
    [pigeons, status, ownersOnly, includeSelf, me?.email],
  );
  const emailList = emails.join("; ");

  const close = () => {
    setOpen(false);
    setStatus("all");
    setOwnersOnly(false);
    setIncludeSelf(false);
    setCopied(false);
  };

  const copy = async () => {
    await navigator.clipboard.writeText(emailList);
    setCopied(true);
  };

  return (
    <Box sx={{ textAlign: "center" }}>
      <Button variant="outlined" onClick={() => setOpen(true)}>
        Get email addresses
      </Button>
      <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
        <DialogTitle>Get email addresses</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth>
              <InputLabel>Status</InputLabel>
              <Select
                label="Status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as PigeonSeasonStatus | "all");
                  setCopied(false);
                }}
              >
                <MenuItem value="all">All pigeons</MenuItem>
                <MenuItem value="pending">Pending</MenuItem>
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="out">Out</MenuItem>
              </Select>
            </FormControl>
            <FormControlLabel
              control={
                <Checkbox
                  checked={ownersOnly}
                  onChange={(event) => {
                    setOwnersOnly(event.target.checked);
                    setCopied(false);
                  }}
                />
              }
              label="Owners only (e.g. for fee collection)"
            />
            {me?.email && (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={includeSelf}
                    onChange={(event) => {
                      setIncludeSelf(event.target.checked);
                      setCopied(false);
                    }}
                  />
                }
                label={`Include my own email (${me.email})`}
              />
            )}
            <TextField
              label={`${emails.length} email address${emails.length === 1 ? "" : "es"}`}
              value={emailList}
              multiline
              minRows={4}
              fullWidth
              slotProps={{ htmlInput: { readOnly: true } }}
              onFocus={(event) => event.target.select()}
            />
            {copied && <Alert severity="success">Copied to clipboard.</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Close</Button>
          <Button variant="contained" onClick={copy} disabled={emails.length === 0}>
            Copy
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
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
    <Box sx={{ textAlign: "center" }}>
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
