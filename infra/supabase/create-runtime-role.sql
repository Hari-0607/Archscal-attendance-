\set ON_ERROR_STOP on
\if :{?runtime_password}
\else
  \echo 'Pass the generated password with psql variable runtime_password; do not put it in this file.'
  \quit 2
\endif

CREATE ROLE attendflow_runtime LOGIN PASSWORD :'runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT authenticated TO attendflow_runtime;
