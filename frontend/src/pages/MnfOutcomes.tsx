/**
 * MNF possible outcomes (that Andy sends Sunday nights)
 */

import { Typography, Box } from "@mui/material";

export default function MnfOutcomesPage() {
  return (
    <Box maxWidth={800} mx="auto" >
        <Typography variant="body1" align="center" fontWeight="bold" mb={2}>
            MNF possible outcomes
        </Typography>
        <Typography variant="body1">
            Check back here after the Sunday night football game to see the top 5 finishers for each possible MNF result
        </Typography>
    </Box>
  );
}