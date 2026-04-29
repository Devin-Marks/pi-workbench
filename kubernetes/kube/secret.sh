#!/bin/bash
# Bootstrap the pi-workbench secret. Run ONCE, before applying
# deployment.yaml — the deployment's secretKeyRef lookups will fail
# until this exists. Re-run any time you want to rotate values.
#
#   ./kubernetes/kube/secret.sh
#
# Defaults: random 32-byte JWT secret, empty UI_PASSWORD and API_KEY
# (auth disabled). Edit the --from-literal values below before running
# to enable password / API-key auth out of the gate, OR run
# `kubectl edit secret pi-workbench-secret -n pi-workbench` afterwards.
set -euo pipefail

kubectl create secret generic pi-workbench-secret \
  --namespace=pi-workbench \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=UI_PASSWORD="" \
  --from-literal=API_KEY="" \
  --dry-run=client -o yaml | kubectl apply -f -
