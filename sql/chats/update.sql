UPDATE chats
SET title = COALESCE($3::text, title),
    archived_at = CASE
      WHEN $4::boolean IS NULL THEN archived_at
      WHEN $4::boolean THEN COALESCE(archived_at, clock_timestamp())
      ELSE NULL
    END,
    updated_at = clock_timestamp()
WHERE id = $1 AND owner_user_id = $2
RETURNING *;
