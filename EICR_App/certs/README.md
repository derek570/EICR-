# AWS RDS CA Certificate Bundle

Download the AWS RDS combined CA bundle for SSL verification:

```bash
curl -o certs/rds-combined-ca-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

This file is used by `src/db.js` in production to verify the RDS server certificate.
The file is NOT committed to git (it's in .gitignore). Download it as part of the
Docker build or CI/CD pipeline.
