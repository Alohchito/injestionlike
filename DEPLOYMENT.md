## Vercel account signup

The signup and login functions use the PostgreSQL database configured by
`DATABASE_URL`. Set it in the Vercel project's Environment Variables for every
deployment environment you use. It must be a PostgreSQL connection string, for
example `postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require`; do not
commit real credentials to this repository.

The Prisma schema now stores password hashes in `User.passwordHash`. For an
existing database, apply the migration before deploying the new functions:

```sh
npx prisma migrate deploy
```

Vercel runs `npm run build` to generate the Prisma Client. If this is a new,
empty database, provision the rest of the application's schema before applying
the migration. Do not set `DATABASE_URL` to a local SQLite file; the schema uses
PostgreSQL.