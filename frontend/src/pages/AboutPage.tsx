import { useEffect } from "react";
import { Typography, Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper } from "@mui/material";
import { Link } from "react-router-dom";
import { PageScroll, NORMAL_PAGE_MAX_WIDTH } from "../components/Layout";
import { useAppCache } from "../hooks/useAppCache";
import { getPayouts } from "../backend/fetch";

export default function AboutPage() {
    const cacheGetPayouts = useAppCache((s) => s.getPayouts);
    const cacheSetPayouts = useAppCache((s) => s.setPayouts);
    const payouts = useAppCache((s) => s.payouts?.data ?? null);

    useEffect(() => {
        if (cacheGetPayouts()) return;
        getPayouts()
            .then((data) => cacheSetPayouts(data))
            .catch(() => {/* non-fatal — table stays hidden */});
    }, [cacheGetPayouts, cacheSetPayouts]);

    return (
        <PageScroll maxWidth={NORMAL_PAGE_MAX_WIDTH}>
            <Typography variant="h6" gutterBottom align="center" fontWeight={700}>
                Pigeon pool rules
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
                <b>1.</b> Submit your picks from the <Link to="/enter-picks">Enter Picks page</Link> by Tuesday, 5PM PST.
                You must pick the WINNER of each game and by how many points they will win (SPREAD).
                If you don't submit picks by the deadline, you will get a last place finish for the week.
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
                <b>2.</b> You will be able to see everyone's picks on the <Link to="/picks-and-results">Picks and Results</Link> Wednesday morning.
                The <Link to="/analytics">Analytics</Link> page provides analysis of your picks, including which are the most important and
                how you can finish in the money.
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
                <b>3.</b> Your score for the week is the total of the DIFFERENCES between your picked spreads and the actual spreads,
                plus a seven point "penalty" for each game where you did not pick the winning team. The lower your weekly score, the better.
                Partial and final scores will also be available on the <Link to="/picks-and-results">Picks and Results</Link> once the first game has started.
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
                <b>4.</b> Your cumulative score is the sum of your weekly rankings, MINUS your highest weekly ranking.
                The lower your cumulative score, the better. You can view your weekly and cumulative scores on
                the <Link to="/year-to-date">Year-to-date page</Link>.
            </Typography>
            <Typography variant="body1" sx={{ mb: 1 }}>
                <b>5.</b> Payoffs are per the table below and are sent by US mail.
            </Typography>
            {payouts && payouts.length > 0 && (
                <Box mt={1}>
                    <Typography variant="h6" gutterBottom align="center">Payoff Table</Typography>
                    <TableContainer component={Paper} sx={{ maxWidth: 500, mx: "auto" }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell align="center"></TableCell>
                                    {payouts.map((r) => (
                                        <TableCell key={r.place} align="center">{ordinal(r.place)}</TableCell>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                <TableRow>
                                    <TableCell component="th" scope="row" align="center">Weekly</TableCell>
                                    {payouts.map((r) => (
                                        <TableCell key={r.place} align="center">{r.points}</TableCell>
                                    ))}
                                </TableRow>
                                <TableRow>
                                    <TableCell component="th" scope="row" align="center">Cumulative</TableCell>
                                    {payouts.map((r) => (
                                        <TableCell key={r.place} align="center">{r.points}</TableCell>
                                    ))}
                                </TableRow>
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Box>
            )}
        </PageScroll>
    );
}

function ordinal(n: number): string {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
