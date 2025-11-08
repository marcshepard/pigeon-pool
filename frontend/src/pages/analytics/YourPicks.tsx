import { useMemo, useState } from "react";

import { Box, Typography, IconButton } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

import { InfoPopover, PointsText } from "../../components/CommonComponents";
import { DataGridLite, type ColumnDef } from "../../components/DataGridLite";
import { useResults } from "../../hooks/useResults";

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

  // Show all games (no filter)
  const remGames: Game[] = useMemo(() => games, [games]);

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
        if (signed === 0) outcome = g.status === "in_progress" ? "TIE (live)" : "TIE";
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
          if (typeof other !== "number" || other === 0) continue;
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
          if (typeof other !== "number" || other === 0) continue;
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


  const [detailsAnchor, setDetailsAnchor] = useState<null | HTMLElement>(null);
  const [infoAnchor, setInfoAnchor] = useState<null | HTMLElement>(null);
  const [actualInfoAnchor, setActualInfoAnchor] = useState<null | HTMLElement>(null);
  const infoText = "Avg points gained on other pigeons if your pick is exactly right";
  const actualInfoText = "Average points gained (or lost if negative) vs other pigeons based on the actual result";

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
    { key: "outcome", header: "Actual Result", renderCell: (r) => r.outcome, align: "center" },
    {
      key: "actualPoints",
      header: (
        <Box display="flex" alignItems="center" gap={0.5}>
          Actual Gain
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
      <Typography variant="body1" sx={{ mb: 1 }}>
        Your most important picks are the ones with the highest{' '}
        <Box component="span" sx={{ display: 'inline' }}>
          <a
            href="#"
            style={{ color: '#1976d2', textDecoration: 'underline', cursor: 'pointer' }}
            onClick={e => {
              e.preventDefault();
              setInfoAnchor(e.currentTarget as HTMLElement);
            }}
          >
            possible gain
          </a>
        </Box>
      </Typography>

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