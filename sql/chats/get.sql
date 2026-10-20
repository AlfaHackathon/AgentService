SELECT *
FROM chats
WHERE id = $1 AND owner_user_id = $2;
