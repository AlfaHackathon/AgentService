UPDATE chats
SET updated_at = clock_timestamp()
WHERE id = $1 AND owner_user_id = $2;
