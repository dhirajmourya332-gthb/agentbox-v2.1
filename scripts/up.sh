#!/usr/bin/env bash
# Create (first run) or start the agentbox VM, provision it, deploy the app.
source "$(dirname "$0")/env.sh"

case "$(vm_status)" in
  "")
    echo "==> creating VM $VM_NAME in $LIMA_HOME"
    "$LIMACTL" create --tty=false --name "$VM_NAME" \
      --set ".mounts = [{\"location\": \"$REPO_DIR\", \"mountPoint\": \"$SRC_MOUNT\", \"writable\": false}]" \
      "$REPO_DIR/lima/agentbox.yaml"
    "$LIMACTL" start --tty=false "$VM_NAME"
    ;;
  Running) echo "==> $VM_NAME already running" ;;
  *)
    echo "==> starting $VM_NAME"
    "$LIMACTL" start --tty=false "$VM_NAME"
    ;;
esac

echo "==> provisioning (idempotent)"
vm sudo bash "$SRC_MOUNT/vm/provision.sh" "$(vm whoami)"

"$REPO_DIR/scripts/deploy.sh"

cat <<EOF

agentbox is up:
  UI        http://localhost:7700
  Screen    http://localhost:7701/vnc.html
  Terminal  http://localhost:7702
EOF
