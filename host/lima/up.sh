#!/usr/bin/env bash
# Create (first run) or start the Lima VM, bootstrap it, install the enabled modules, deploy.
#   host/lima/up.sh [--instance NAME] [--ports BASE] [--lima-home DIR] [--cpus N --memory 6GiB --disk 60GiB]
source "$(dirname "$0")/lib.sh"

case "$(vm_status)" in
  "")
    for port in $PORT_GUIDE $PORT_PORTAL $PORT_SCREEN $PORT_TERMINAL; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "error: port $port is already in use on this Mac; pick another --ports base" >&2; exit 1
      fi
    done
    echo "==> creating VM $VM_NAME in $LIMA_HOME (ports $PORT_GUIDE-$PORT_TERMINAL, $CPUS cpu, $MEMORY, $DISK)"
    tmpl="$(mktemp -t agentbox-lima).yaml"
    sed -e "s|@PORT_PORTAL@|$PORT_PORTAL|g" -e "s|@PORT_SCREEN@|$PORT_SCREEN|g" \
        -e "s|@PORT_TERMINAL@|$PORT_TERMINAL|g" -e "s|@PORT_GUIDE@|$PORT_GUIDE|g" \
        -e "s|@CPUS@|$CPUS|g" -e "s|@MEMORY@|$MEMORY|g" -e "s|@DISK@|$DISK|g" \
        "$REPO_DIR/lima/agentbox.yaml" > "$tmpl"
    "$LIMACTL" create --tty=false --name "$VM_NAME" \
      --set ".mounts = [{\"location\": \"$REPO_DIR\", \"mountPoint\": \"$SRC_MOUNT\", \"writable\": false}]" \
      "$tmpl"
    rm -f "$tmpl"
    "$LIMACTL" start --tty=false "$VM_NAME"
    ;;
  Running) echo "==> $VM_NAME already running" ;;
  *)
    echo "==> starting $VM_NAME"
    "$LIMACTL" start --tty=false "$VM_NAME"
    ;;
esac

echo "==> bootstrap (idempotent)"
vm sudo bash "$SRC_MOUNT/setup/bootstrap.sh" --host lima

echo "==> installing the enabled modules"
vm sudo agentbox module install --enabled

cat <<EOF

agentbox is up in $VM_NAME:
$(urls)
  Guide     http://localhost:$PORT_GUIDE   (when the guide is installed)
Shell: host/lima/shell.sh --instance $VM_NAME
EOF
