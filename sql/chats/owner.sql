SELECT owner_user_id
FROM chats
WHERE id = $1 AND agent_key = 'client-assistant';
