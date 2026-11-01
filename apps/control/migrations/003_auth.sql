-- Sign-in methods beyond email + password: external identities (GitHub, GitLab, Bitbucket, Google, SSO),
-- password reset tokens, and a verified-email marker used to decide when an identity may be linked by email.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

CREATE TABLE user_identities (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,              -- github | gitlab | bitbucket | google | sso
  subject     text NOT NULL,              -- provider's stable user id
  email       text,
  username    text,
  avatar_url  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (provider, subject),
  UNIQUE (user_id, provider)
);
CREATE INDEX user_identities_user ON user_identities(user_id);

-- Existing GitHub links become identities; GitHub only hands out verified primary emails.
INSERT INTO user_identities (id, user_id, provider, subject, email, username, avatar_url)
SELECT 'idn-' || substr(md5(u.id), 1, 20), u.id, 'github', u.github_id::text, u.email, u.github_login, u.avatar_url
FROM users u WHERE u.github_id IS NOT NULL;
UPDATE users SET email_verified_at = created_at WHERE github_id IS NOT NULL;

CREATE TABLE password_resets (
  id          text PRIMARY KEY,           -- sha256(token)
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text
);
CREATE INDEX password_resets_user ON password_resets(user_id);
