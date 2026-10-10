# Security Policy

## Supported version

This learning project currently supports only the latest commit on the default
branch. It does not maintain security patches for older tags or forks.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, leaked credential, or exploit in a
public issue.

If GitHub private vulnerability reporting is enabled for this repository, use
the repository's **Security → Advisories → Report a vulnerability** workflow.
Otherwise, contact the repository owner privately before publishing details.

Include the affected file or endpoint, reproduction conditions, potential
impact, and any suggested remediation. Do not include real provider keys,
customer data, or other confidential material in the report.

## Demo boundary

This repository is an educational demonstration. A public deployment requires
additional controls such as user authentication, distributed rate limiting,
monitoring, abuse detection, and provider-side budgets. CloudFront Origin
Access Control protects the Lambda origin but does not authenticate visitors.
