import { Typography, Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper } from "@mui/material";
import { Link } from "react-router-dom";
import { PageScroll, NORMAL_PAGE_MAX_WIDTH } from "../components/Layout";

export default function AboutPage() {
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
                plus a seven point “penalty” for each game where you did not pick the winning team. The lower your weekly score, the better.
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
            <Box mt={4}>
                <Typography variant="h6" gutterBottom align="center">Payoff Table</Typography>
                <TableContainer component={Paper} sx={{ maxWidth: 500, mx: "auto" }}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell align="center"></TableCell>
                                <TableCell align="center">1st</TableCell>
                                <TableCell align="center">2nd</TableCell>
                                <TableCell align="center">3rd</TableCell>
                                <TableCell align="center">4th</TableCell>
                                <TableCell align="center">5th</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            <TableRow>
                                <TableCell component="th" scope="row" align="center">Weekly</TableCell>
                                <TableCell align="center">530</TableCell>
                                <TableCell align="center">270</TableCell>
                                <TableCell align="center">160</TableCell>
                                <TableCell align="center">100</TableCell>
                                <TableCell align="center">70</TableCell>
                            </TableRow>
                            <TableRow>
                                <TableCell component="th" scope="row" align="center">Cummulative</TableCell>
                                <TableCell align="center">530</TableCell>
                                <TableCell align="center">270</TableCell>
                                <TableCell align="center">160</TableCell>
                                <TableCell align="center">100</TableCell>
                                <TableCell align="center">70</TableCell>
                            </TableRow>
                        </TableBody>
                    </Table>
                </TableContainer>
            </Box>
        </PageScroll>
    );
}
