/**
 * Home page component.
 */

import { Typography, Box, Stack, Paper } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import EditNoteIcon from "@mui/icons-material/EditNote";
import ListAltIcon from "@mui/icons-material/ListAlt";
import EmojiEventsIcon from "@mui/icons-material/EmojiEvents";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import BarChartIcon from "@mui/icons-material/BarChart";

import { NORMAL_PAGE_MAX_WIDTH, PageScroll } from "../components/Layout";
import { useAuth } from "../auth/useAuth";

// Wider cap than NORMAL_PAGE_MAX_WIDTH so the banner can stretch across the
// content pane (unlike the tiles below, which stay at reading width), while
// still capping out on ultra-wide screens.
const BANNER_MAX_WIDTH = 1400;

const tiles = [
    {
        path: "/enter-picks",
        icon: <EditNoteIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Enter Picks",
        desc: "Enter picks for an upcoming week",
    },
    {
        path: "/picks-and-results",
        icon: <ListAltIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Picks and Results",
        desc: "View the picksheet and results for this or a previous week",
    },
    {
        path: "/analytics",
        icon: <BarChartIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Analytics",
        desc: "Analyze your picks and outcome possibilities",
    },
    {
        path: "/year-to-date",
        icon: <EmojiEventsIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "Year-to-Date",
        desc: "View the year-to-date leaderboard",
    },
    {
        path: "/about",
        icon: <InfoOutlinedIcon color="primary" sx={{ fontSize: 40 }} />,
        label: "About",
        desc: "Read the rules",
    },
];

export default function HomePage() {
    const { me } = useAuth();
    const tenantName = me?.activeTenant?.name ?? "Pigeon Pool";
    const feedbackEmail = "marcshepard@outlook.com";
    const feedbackBody = `Hey Marc,\n\nI'm ${me?.pigeon_name ?? "<pigeon name>"} from ${tenantName}.\n\n<feedback>`;
    const feedbackMailto = `mailto:${feedbackEmail}?subject=${encodeURIComponent("Pigeon Pool feedback")}&body=${encodeURIComponent(feedbackBody)}`;
    return (
        <PageScroll sx={{ px: 1 }}>
            <Box sx={{ width: "100%", maxWidth: NORMAL_PAGE_MAX_WIDTH, mx: "auto" }}>
                <Typography variant="h6" fontWeight="bold" align="center">
                    Welcome to {tenantName}
                </Typography>
            </Box>

            <Box sx={{ width: "100%", maxWidth: BANNER_MAX_WIDTH, mx: "auto", mt: 3 }}>
                <Box
                    sx={{
                        width: "100%",
                        height: { xs: 90, sm: 130, md: 170 },
                        overflow: "hidden",
                        borderRadius: 3,
                    }}
                >
                    <Box
                        component="img"
                        src="/home.png"
                        alt="Pigeons checking picks on their phones"
                        sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                </Box>
            </Box>

            <Box sx={{ width: "100%", maxWidth: NORMAL_PAGE_MAX_WIDTH, mx: "auto" }}>
                <Stack spacing={{ xs: 1.5, sm: 3 }} mt={{ xs: 2, sm: 3 }} mb={0}>
                    {tiles.map((tile) => (
                        <Paper
                            key={tile.path}
                            elevation={4}
                            sx={{
                                display: "flex",
                                alignItems: "center",
                                p: 2.5,
                                borderRadius: 3,
                                boxShadow: 3,
                                transition: "box-shadow 0.2s, transform 0.2s",
                                cursor: "pointer",
                                '&:hover': {
                                    boxShadow: 8,
                                    transform: "translateY(-2px) scale(1.02)",
                                    backgroundColor: (theme) => theme.palette.action.hover,
                                },
                                textDecoration: "none",
                                color: "inherit",
                            }}
                            component={RouterLink}
                            to={tile.path}
                        >
                            <Box sx={{ mr: 2, flexShrink: 0 }}>{tile.icon}</Box>
                            <Box>
                                <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
                                    {tile.label}
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    {tile.desc}
                                </Typography>
                            </Box>
                        </Paper>
                    ))}
                </Stack>
                <Typography variant="body2" color="text.secondary" align="center" sx={{ mt: { xs: 1.5, sm: 3 }, mb: 2 }}>
                    Bugs/feedback? {" "}
                    <Box component="a" href={feedbackMailto} sx={{ color: "inherit" }}>
                        {feedbackEmail}
                    </Box>
                </Typography>
            </Box>
        </PageScroll>
    );
}
