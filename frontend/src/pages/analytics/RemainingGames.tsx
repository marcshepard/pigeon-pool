import { useMemo, useState } from "react";
import { Box, Button, Typography, IconButton } from "@mui/material";
import { InfoPopover } from "../../components/CommonComponents";
import { DataGridLite, type ColumnDef } from "../../components/DataGridLite";
import { PointsText } from "../../components/CommonComponents";
import { useResults } from "../../hooks/useResults";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

type Game = {
  game_id: number;
  away_abbr: string;
  home_abbr: string;
  status?: string;
  home_score?: number | null;
  away_score?: number | null;
  kickoff_at?: string;
};

type Row = {
  gameName: string;
  kickoff: string;
  consensus: string;
  userPick: string;
  outcome: string;
  possiblePoints: number | null;
  actualPoints: number | null;
  actualPointsLive: boolean;
};

function formatGameName(g: Game) {
  return `${g.away_abbr} @ ${g.home_abbr}`;
}

function formatKickoff(dt?: string) {
  if (!dt) return "";
  const d = new Date(dt);
  return d.toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

// Per-pick score given predicted signed margin and actual signed margin
function pickScore(predSigned: number, actualSigned: number) {
  return Math.abs(predSigned - actualSigned) + (Math.sign(predSigned) !== Math.sign(actualSigned) ? 7 : 0);
}

export default function RemainingGames({ week, pigeon }: { week: number; pigeon: number }) {
  const { rows, games, consensusRow, loading, error } = useResults(week);
  const userRow = rows.find((r) => r.pigeon_number === pigeon) || null;

  // Only in-progress or scheduled games
  const remGames: Game[] = useMemo(
    () => games.filter((g) => g.status !== "final"),
    [games]
  );

  // Build table rows, patterned after KeyPicks
  const tableRows: Row[] = useMemo(() => {
    return remGames.map((g) => {
      const key = `g_${g.game_id}`;
      const consensus = consensusRow?.picks[key]?.label || "—";

      // Just the pick (strip trailing " (N)")
      let userPick = userRow?.picks[key]?.label || "—";
      userPick = userPick.replace(/ \(.*\)$/, "");

      // Outcome: show live score if in progress
      let outcome = "";
      if ((g.status === "final" || g.status === "in_progress") && g.home_score != null && g.away_score != null) {
        const signed = g.home_score - g.away_score;
        if (signed === 0) outcome = g.status === "in_progress" ? "TIE 0 (live)" : "TIE 0";
        else outcome = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}${g.status === "in_progress" ? " (live)" : ""}`;
      }

      // Possible Gain: average points gained if user's pick is exactly right
      let possiblePoints: number | null = null;
      if (userRow && typeof userRow.picks[key]?.signed === "number") {
        const userSigned = userRow.picks[key].signed;
        let sum = 0,
          n = 0;
        for (const r of rows) {
          if (r.pigeon_number === pigeon) continue;
          const other = r.picks[key]?.signed;
          if (typeof other !== "number") continue;
          const otherScore = pickScore(other, userSigned);
          sum += otherScore; // user would be 0 if exactly right
          n++;
        }
        possiblePoints = n ? sum / n : null;
      }

      // Actual Gain: avg points gained/lost vs others for live games
      let actualPoints: number | null = null;
      let actualPointsLive = false;
      if (
        userRow &&
        (g.status === "final" || g.status === "in_progress") &&
        typeof userRow.picks[key]?.signed === "number" &&
        g.home_score != null &&
        g.away_score != null
      ) {
        const actual = g.home_score - g.away_score;
        const uPred = userRow.picks[key].signed;
        const userScore = pickScore(uPred, actual);
        let sum = 0,
          n = 0;
        for (const r of rows) {
          if (r.pigeon_number === pigeon) continue;
          const other = r.picks[key]?.signed;
          if (typeof other !== "number") continue;
          const otherScore = pickScore(other, actual);
          sum += otherScore - userScore;
          n++;
        }
        actualPoints = n ? sum / n : null;
        actualPointsLive = g.status === "in_progress";
      }

      return {
        gameName: formatGameName(g),
        kickoff: formatKickoff(g.kickoff_at),
        consensus,
        userPick,
        outcome,
        possiblePoints,
        actualPoints,
        actualPointsLive,
      } satisfies Row;
    });
  }, [remGames, consensusRow, rows, userRow, pigeon]);

  // Ranks header: current rank (finals + live-as-final), best possible rank (future as user's picks)
  const { currentRankStr, bestRankStr } = useMemo(() => {
    if (!rows.length) return { currentRankStr: "—", bestRankStr: "—" };

    const basePoints = new Map<number, number>();
    for (const r of rows) basePoints.set(r.pigeon_number, r.points ?? 0);

    // 1) Current rank: treat in-progress as if ended now
    const nowTotals = new Map<number, number>(basePoints);
    for (const g of games) {
      if (g.status !== "in_progress") continue;
      if (g.home_score == null || g.away_score == null) continue;
      const actual = g.home_score - g.away_score;
      const key = `g_${g.game_id}`;
      for (const r of rows) {
        const pred = r.picks[key]?.signed;
        if (typeof pred !== "number") continue;
        nowTotals.set(r.pigeon_number, (nowTotals.get(r.pigeon_number) ?? 0) + pickScore(pred, actual));
      }
    }

    const currentUserTotal = nowTotals.get(pigeon);
    let currentRankStr = "—";
    if (typeof currentUserTotal === "number") {
      const totals = [...nowTotals.values()];
      const sorted = [...totals].sort((a, b) => a - b);
      const rank = sorted.findIndex((t) => t === currentUserTotal) + 1;
      const tie = totals.filter((t) => t === currentUserTotal).length > 1;
      currentRankStr = `${tie ? "T" : ""}${rank}`;
    }

    // 2) Best possible rank: assume every non-final ends exactly as user picked
    const bestTotals = new Map<number, number>(basePoints);
    const uRow = userRow;
    if (uRow) {
      for (const g of games) {
        if (g.status === "final") continue;
        const key = `g_${g.game_id}`;
        const uPred = uRow.picks[key]?.signed;
        if (typeof uPred !== "number") continue; // if user has no pick, skip game
        // This becomes the hypothetical actual
        const actual = uPred;
        for (const r of rows) {
          const pred = r.picks[key]?.signed;
          if (typeof pred !== "number") continue;
          bestTotals.set(r.pigeon_number, (bestTotals.get(r.pigeon_number) ?? 0) + pickScore(pred, actual));
        }
      }
    }

    const bestUserTotal = bestTotals.get(pigeon);
    let bestRankStr = "—";
    if (typeof bestUserTotal === "number") {
      const totals = [...bestTotals.values()];
      const sorted = [...totals].sort((a, b) => a - b);
      const rank = sorted.findIndex((t) => t === bestUserTotal) + 1;
      const tie = totals.filter((t) => t === bestUserTotal).length > 1;
      bestRankStr = `${tie ? "T" : ""}${rank}`;
    }

    return { currentRankStr, bestRankStr };
  }, [rows, games, pigeon, userRow]);

  const [detailsAnchor, setDetailsAnchor] = useState<null | HTMLElement>(null);
  const [infoAnchor, setInfoAnchor] = useState<null | HTMLElement>(null);
  const [actualInfoAnchor, setActualInfoAnchor] = useState<null | HTMLElement>(null);
  const infoText = "Avg points gained on other pigeons if your pick is exactly right";
  const actualInfoText = "Average points gained (or lost if negative) vs other pigeons if the current live score holds";

  const columns: ColumnDef<Row>[] = [
    {
      key: "gameName",
      header: "Game",
      renderCell: (r) => (
        <Box>
          <div>{r.gameName}</div>
          <Typography variant="caption" color="text.secondary">
            {r.kickoff}
          </Typography>
        </Box>
      ),
      align: "left",
    },
    { key: "consensus", header: "Consensus", renderCell: (r) => r.consensus, align: "center" },
    { key: "userPick", header: "Your Pick", renderCell: (r) => r.userPick, align: "center" },
    {
      key: "possiblePoints",
      header: (
        <Box display="flex" alignItems="center" gap={0.5}>
          Possible Gain
          <IconButton
            size="small"
            onClick={e => setInfoAnchor(e.currentTarget as HTMLElement)}
            aria-label="Possible Gain Info"
          >
            <InfoOutlinedIcon fontSize="inherit" />
          </IconButton>
        </Box>
      ),
      renderCell: (r) => (r.possiblePoints != null ? <PointsText>{r.possiblePoints.toFixed(1)}</PointsText> : "—"),
      valueGetter: (r) => r.possiblePoints,
      align: "center",
    },
    { key: "outcome", header: "Live Score", renderCell: (r) => r.outcome, align: "center" },
    {
      key: "actualPoints",
      header: (
        <Box display="flex" alignItems="center" gap={0.5}>
          Current Gain
          <IconButton
            size="small"
            onClick={e => setActualInfoAnchor(e.currentTarget as HTMLElement)}
            aria-label="Actual Gain Info"
          >
            <InfoOutlinedIcon fontSize="inherit" />
          </IconButton>
        </Box>
      ),
      renderCell: (r) =>
        r.actualPoints != null ? (
          <PointsText>
            {r.actualPoints.toFixed(1)}
            {r.actualPointsLive ? " (live)" : ""}
          </PointsText>
        ) : (
          ""
        ),
      valueGetter: (r) => r.actualPoints,
      nullsLastAlways: true,
      align: "center",
    },
  ];

  if (loading) return <Typography>Loading…</Typography>;
  if (error) return <Typography color="error">{error}</Typography>;

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 2, mb: 2 }}>
        <Typography variant="body1">
          Current rank: <strong>{currentRankStr}</strong>
        </Typography>
        <Typography variant="body1">
          Best possible rank: <strong>{bestRankStr}</strong>
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={e => setDetailsAnchor(e.currentTarget as HTMLElement)}
          className="print-hide"
        >
          show me details
        </Button>
      </Box>

      <DataGridLite
        rows={tableRows}
        columns={columns}
        zebra
        emptyMessage="No remaining games."
        defaultSort={{ key: "possiblePoints", dir: "desc" }}
      />

      <InfoPopover
        anchorEl={detailsAnchor}
        onClose={() => setDetailsAnchor(null)}
      >
        <Typography>Coming soon</Typography>
      </InfoPopover>
      <InfoPopover
        anchorEl={infoAnchor}
        onClose={() => setInfoAnchor(null)}
      >
        {infoText}
      </InfoPopover>
      <InfoPopover
        anchorEl={actualInfoAnchor}
        onClose={() => setActualInfoAnchor(null)}
      >
        {actualInfoText}
      </InfoPopover>
    </Box>
  );
}