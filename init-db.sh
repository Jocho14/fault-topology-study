#!/bin/bash

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE shop_db;
    CREATE DATABASE warehouse_db;
    CREATE DATABASE payment_db;
    CREATE DATABASE delivery_db;
EOSQL