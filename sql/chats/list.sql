SELECT *
FROM chats
WHERE owner_user_id = $1
  AND (
    $2::text = 'all'
    OR ($2::text = 'active' AND archived_at IS NULL)
    OR ($2::text = 'archived' AND archived_at IS NOT NULL)
  )
  AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
ORDER BY updated_at DESC, id DESC
LIMIT $5;
