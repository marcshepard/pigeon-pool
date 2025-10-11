SELECT pigeon_name, game_name, predicted_margin, actual_margin, diff, penalty, points
    FROM v_results
    WHERE week_number = 5 AND pigeon_number = 11
    ORDER BY pigeon_number, game_id;

