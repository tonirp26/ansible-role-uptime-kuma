# Ansible Role: Uptime Kuma

This role installs the Uptime Kuma application. Uptime Kuma is an easy-to-use self-hosted monitoring tool designed to send alerts when monitored services go down and to track uptime statistics.

After running the role, the `uptime-kuma` service will be available on the server. The application's web interface can be accessed at `http://{your-container-ip}:3001`.

## Requirements

Requires Node 22 or later to be installed on the server (you can use the geerlingguy.nodejs role to install Node if needed).

## Role Variables

Available variables are listed below, along with default values (see `defaults/main.yml`):

```yaml
app_repository_url: "https://github.com/louislam/uptime-kuma.git"
```

URL used in git clone command.

```yaml
app_repository_dir: "/opt/uptime-kuma"
```

Set repository destination path, if modified make sure that system user `uptime-kuma` can made changes.

```yaml
app_version: "2.5.5"
```

Set desired version of the app.

```yaml
systemd_template: "2.5.5"
```

The template to use when generating systemd service.

## Dependencies

None.

## Example Playbook

```yaml
- hosts: server
  vars_files:
    - vars/main.yml
  roles:
    - { role: geerlingguy.firewall }
```

*Inside `vars/main.yml`*:

```yaml
app_version: 2.5.5
```

## License

## Author Information

This role was created in 2026 by [tonirp](https://github.com/tonirp26)
