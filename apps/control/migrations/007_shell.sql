-- Port of each agent's shell endpoint (on the node's private address); null when the node offers none.
ALTER TABLE nodes ADD COLUMN agent_port integer;
