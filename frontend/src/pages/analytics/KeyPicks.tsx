
import { useState } from "react";
import { useResults } from "../../hooks/useResults";
import { DataGridLite, type ColumnDef } from "../../components/DataGridLite";
import { Box, Typography, IconButton, Button } from "@mui/material";
import { InfoPopover } from "../../components/CommonComponents";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { PointsText } from "../../components/CommonComponents";

type Game = {
  game_id: number;
  away_abbr: string;
  home_abbr: string;
  status?: string;
  home_score?: number | null;
  away_score?: number | null;
  kickoff_at?: string;
};

type KeyPickRow = {
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

function formatKickoff(dt: string) {
  const d = new Date(dt);
  return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
}

export default function KeyPicks({ week, pigeon }: { week: number; pigeon: number }) {
  const { rows, games, consensusRow, loading, error } = useResults(week);
  const userRow = rows.find(r => r.pigeon_number === pigeon);

  // Build table rows
  const tableRows: KeyPickRow[] = games.map(g => {
    const key = `g_${g.game_id}`;
    const consensus = consensusRow?.picks[key]?.label || "—";
    // Show only the pick (not the points) in the 'Your Pick' column
    let userPick = userRow?.picks[key]?.label || "—";
    userPick = userPick.replace(/ \(.*\)$/, "");
    // Outcome column logic
    let outcome = "";
    if (g.status === "final" && g.home_score != null && g.away_score != null) {
      const signed = g.home_score - g.away_score;
      if (signed === 0) outcome = "TIE 0";
      else outcome = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
    } else if (g.status === "in_progress" && g.home_score != null && g.away_score != null) {
      const signed = g.home_score - g.away_score;
      if (signed === 0) outcome = "TIE 0 (live)";
      else outcome = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)} (live)`;
    }
    // Possible points: average points gained if user pick is exactly right (vs all other picks)
    let possiblePoints: number | null = null;
    if (userRow && typeof userRow.picks[key]?.signed === "number") {
      const userSigned = userRow.picks[key].signed;
      // For each other pigeon, compute score difference if user is exactly right
      let sum = 0, n = 0;
      for (const r of rows) {
        if (r.pigeon_number === pigeon) continue;
        if (typeof r.picks[key]?.signed !== "number") continue;
        const otherScore = Math.abs(r.picks[key].signed - userSigned) + (Math.sign(r.picks[key].signed) !== Math.sign(userSigned) ? 7 : 0);
        sum += otherScore;
        n++;
      }
      // If user is exactly right, their score is 0, so possible points = avg(otherScore)
      possiblePoints = n ? sum / n : null;
    }
    // Actual points: avg points gained/lost vs others, if game is final or in progress
    let actualPoints: number | null = null;
    let actualPointsLive = false;
    if (userRow && (g.status === "final" || g.status === "in_progress") && typeof userRow.picks[key]?.signed === "number" && g.home_score != null && g.away_score != null) {
      const actual = g.home_score - g.away_score;
      const userScore = Math.abs(userRow.picks[key].signed - actual) + (Math.sign(userRow.picks[key].signed) !== Math.sign(actual) ? 7 : 0);
      let sum = 0, n = 0;
      for (const r of rows) {
        if (r.pigeon_number === pigeon) continue;
        if (typeof r.picks[key]?.signed !== "number") continue;
        const otherScore = Math.abs(r.picks[key].signed - actual) + (Math.sign(r.picks[key].signed) !== Math.sign(actual) ? 7 : 0);
        sum += otherScore - userScore;
        n++;
      }
      actualPoints = n ? sum / n : null;
      actualPointsLive = g.status === "in_progress";
    }
    return {
      gameName: formatGameName(g),
      kickoff: g.kickoff_at ? formatKickoff(g.kickoff_at) : "",
      consensus,
      userPick,
      outcome,
      possiblePoints,
      actualPoints,
      actualPointsLive,
    };
  });

  const [infoAnchor, setInfoAnchor] = useState<null | HTMLElement>(null);
  const infoText = "Average points gained on other pigeons if your pick is exactly right";
  const actualInfoText = "Actual average points gained (or lost if negative) on other pigeons based on game outcome";
  const [actualInfoAnchor, setActualInfoAnchor] = useState<null | HTMLElement>(null);
  const columns: ColumnDef<KeyPickRow>[] = [
    {
      key: "gameName",
      header: "Game",
      renderCell: (r) => (
        <Box>
          <div>{r.gameName}</div>
          <Typography variant="caption" color="text.secondary">{r.kickoff}</Typography>
        </Box>
      ),
      align: "left",
    },
    { key: "consensus", header: "Consensus", renderCell: r => r.consensus, align: "center" },
    { key: "userPick", header: "Your Pick", renderCell: r => r.userPick, align: "center" },
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
      renderCell: r => r.possiblePoints != null ? <PointsText>{r.possiblePoints.toFixed(1)}</PointsText> : "—",
      valueGetter: r => r.possiblePoints,
      align: "center",
    },
    { key: "outcome", header: "Outcome", renderCell: r => r.outcome, align: "center" },
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
      renderCell: r => r.actualPoints != null ? <PointsText>{r.actualPoints.toFixed(1)}{r.actualPointsLive ? " (live)" : ""}</PointsText> : "",
      valueGetter: r => r.actualPoints,
      nullsLastAlways: true,
      align: "center",
    },
  ];

  if (loading) return <Typography>Loading…</Typography>;
  if (error) return <Typography color="error">{error}</Typography>;

  return (
    <Box>
      <Typography variant="body1" align="center" sx={{ mb: 2 }}>
        The importance of each pick to the rankings (
        <Button
          variant="text"
          size="small"
          sx={{ p: 0, minWidth: 0, textTransform: 'none', fontWeight: 500 }}
          onClick={e => setInfoAnchor(e.currentTarget as HTMLElement)}
        >
          possible gain
        </Button>
        )
      </Typography>
      <DataGridLite
        rows={tableRows}
        columns={columns}
        zebra
        emptyMessage="No games found."
        defaultSort={{ key: "possiblePoints", dir: "desc" }}
      />
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
