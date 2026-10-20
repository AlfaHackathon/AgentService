INSERT INTO chats (id, owner_user_id, title)
VALUES ($1, $2, $3)
RETURNING *;
