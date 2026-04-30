#!/bin/bash
# Bootstrap the pi-workbench secret. Run ONCE, before applying
# deployment.yaml. Re-run any time you want to rotate values.
#
#   ./kubernetes/openshift/secret.sh
#
# Defaults: empty UI_PASSWORD and API_KEY (auth disabled). JWT_SECRET
# is intentionally NOT set here — when UI_PASSWORD is enabled, the
# server auto-generates one on first boot and persists it to
# ${WORKBENCH_DATA_DIR}/jwt-secret on the data-dir PVC, so issued
# tokens survive pod restarts.
#
# Edit the --from-literal values below before running to enable
# password / API-key auth out of the gate, OR run
# `oc edit secret pi-workbench-secret -n pi-workbench` afterwards.
# Add a JWT_SECRET key only if you want to manage it centrally
# (e.g. via an external-secrets controller).
set -euo pipefail

kubectl create secret generic pi-workbench-secret \
  --namespace=pi-workbench \
  --from-literal=UI_PASSWORD="" \
  --from-literal=API_KEY="" \
  --dry-run=client -o yaml | oc apply -f -
