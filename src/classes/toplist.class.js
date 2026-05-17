class Toplist {
    constructor(parentId) {
        if (!parentId) throw "Missing parameters";

        // Create DOM
        this.parent = document.getElementById(parentId);
        this._element = document.createElement("div");
        this._element.setAttribute("id", "mod_toplist");
        this._element.innerHTML = `<h1>TOP PROCESSES<i>PID | NAME | CPU | MEM</i></h1><br>
        <table id="mod_toplist_table"></table>`;
        this._element.onclick = this.processList;

        this.parent.append(this._element);

        this.currentlyUpdating = false;

        this.updateList();
        this.listUpdater = setInterval(() => {
            this.updateList();
        }, 2000);
    }
    updateList() {
        if (this.currentlyUpdating) return;

        this.currentlyUpdating = true;
        window.si.processes().then(data => {
            if (window.settings.excludeThreadsFromToplist === true) {
                data.list = data.list.sort((a, b) => {
                    return (a.pid-b.pid);
                }).filter((e, index, a) => {
                    let i = a.findIndex(x => x.name === e.name);
                    if (i !== -1 && i !== index) {
                        a[i].cpu = a[i].cpu+e.cpu;
                        a[i].mem = a[i].mem+e.mem;
                        return false;
                    }
                    return true;
                });
            }

            let list = data.list.sort((a, b) => {
                return ((b.cpu-a.cpu)*100 + b.mem-a.mem);
            }).splice(0, 5);

            document.querySelectorAll("#mod_toplist_table > tr").forEach(el => {
                el.remove();
            });
            list.forEach(proc => {
                let el = document.createElement("tr");
                // `proc.name` (and `proc.user` in the Active
                // Processes modal below) come from
                // systeminformation reading the OS process list.
                // On Linux/macOS a process name can legitimately
                // contain HTML metacharacters — a user could `mv`
                // a binary to `<img onerror=…>` and run it — so
                // escape before splicing into the row. Issue #171.
                const esc = window._escapeHtml;
                el.innerHTML = `<td>${proc.pid}</td>
                                <td><strong>${esc(proc.name)}</strong></td>
                                <td>${Math.round(proc.cpu*10)/10}%</td>
                                <td>${Math.round(proc.mem*10)/10}%</td>`;
                document.getElementById("mod_toplist_table").append(el);
            });
            this.currentlyUpdating = false;
        });
    }

    processList(){
        // Per-column comparators for the Active-Processes modal. The original
        // 8-case switch had CC 50 (S3776); collapsing each case into a small
        // arrow brings the sort callback to CC ~2. Behaviour is preserved
        // exactly, including the pre-existing inverted `ascending` for the
        // string columns Name/User (where ascending=true sorts Z→A — a
        // latent bug, untouched here).
        const stringCmp = (a, b) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        };
        const COMPARATORS = {
            PID:     (a, b, asc) => asc ? a.pid - b.pid : b.pid - a.pid,
            Name:    (a, b, asc) => asc ? -stringCmp(a.name, b.name) : stringCmp(a.name, b.name),
            User:    (a, b, asc) => asc ? -stringCmp(a.user, b.user) : stringCmp(a.user, b.user),
            CPU:     (a, b, asc) => asc ? a.cpu - b.cpu : b.cpu - a.cpu,
            Memory:  (a, b, asc) => asc ? a.mem - b.mem : b.mem - a.mem,
            State:   (a, b)      => stringCmp(a.state, b.state),
            Started: (a, b, asc) => asc
                ? Date.parse(a.started) - Date.parse(b.started)
                : Date.parse(b.started) - Date.parse(a.started),
            Runtime: (a, b, asc) => asc ? a.runtime - b.runtime : b.runtime - a.runtime,
        };

        let sortKey;
        let ascending = false;
        let removed = false;
        let currentlyUpdating = false;

        function setSortKey(fieldName){
            if (sortKey === fieldName){
                if (ascending){
                    sortKey = undefined;
                    ascending = false;
                }
                else{
                    ascending = true;
                }
            }
            else {
                sortKey = fieldName;
                ascending = false;
            }
        }

        function formatRuntime(ms){
            const msInDay = 24 * 60 * 60 * 1000;
            let days = Math.floor(ms / msInDay);
            let remainingMS = ms % msInDay;

            const msInHour = 60 * 60 * 1000;
            let hours = Math.floor(remainingMS / msInHour);
            remainingMS = ms % msInHour;

            let msInMin = 60 * 1000;
            let minutes = Math.floor(remainingMS / msInMin);
            remainingMS = ms % msInMin;

            let seconds = Math.floor(remainingMS / 1000);

            return `${days < 10 ? "0" : ""}${days}:${hours < 10 ? "0" : ""}${hours}:${minutes < 10 ? "0" : ""}${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
        }

        function updateProcessList() {
            if (currentlyUpdating) return;
            currentlyUpdating = true;
            window.si.processes().then(data => {
                if (window.settings.excludeThreadsFromToplist === true) {
                    data.list = data.list.sort((a, b) => {
                        return (a.pid - b.pid);
                    }).filter((e, index, a) => {
                        let i = a.findIndex(x => x.name === e.name);
                        if (i !== -1 && i !== index) {
                            a[i].cpu = a[i].cpu + e.cpu;
                            a[i].mem = a[i].mem + e.mem;
                            return false;
                        }
                        return true;
                    });
                }

                data.list.forEach(proc => {
                    proc.runtime = new Date(Date.now() - Date.parse(proc.started));
                });

                currentlyUpdating = false;
                let list = data.list.sort((a, b) => {
                    const cmp = COMPARATORS[sortKey];
                    if (cmp) return cmp(a, b, ascending);
                    // Default — same priority as the always-on Toplist panel.
                    return ((b.cpu - a.cpu) * 100 + b.mem - a.mem);
                });

                if (removed) clearInterval(updateInterval);
                else {
                    document.querySelectorAll("#processList > tr").forEach(el => {
                        el.remove();
                    });

                    list.forEach(proc => {
                        let el = document.createElement("tr");
                        // See the note in updateList() above —
                        // proc.{name,user,state,started} all carry
                        // OS-supplied text that can include HTML
                        // metacharacters. Escape per cell. #171.
                        const esc = window._escapeHtml;
                        el.innerHTML = `<td class="pid">${proc.pid}</td>
                            <td class="name">${esc(proc.name)}</td>
                            <td class="user">${esc(proc.user)}</td>
                            <td class="cpu">${Math.round(proc.cpu * 10) / 10}%</td>
                            <td class="mem">${Math.round(proc.mem * 10) / 10}%</td>
                            <td class="state">${esc(proc.state)}</td>
                            <td class="started">${esc(proc.started)}</td>
                            <td class="runtime">${formatRuntime(proc.runtime)}</td>`;
                        document.getElementById("processList").append(el);
                    });
                }
            });
        }

        window.keyboard.detach();
        new Modal(
            {
                type: "custom",
                title: "Active Processes",
                html: `
<table id=\"processContainer\">
    <thead>
        <tr>
            <td class="pid header">PID</td>
            <td class="name header">Name</td>
            <td class="user header">User</td>
            <td class="cpu header">CPU</td>
            <td class="mem header">Memory</td>
            <td class="state header">State</td>
            <td class="started header">Started</td>
            <td class="runtime header">Runtime</td>
        </tr>
    </thead>
    <tbody id=\"processList\">
    </tbody>
  </table>`,
            },
            () => {
                removed = true;
                //clearInterval(updateInterval);
            }
        );

        let headers = document.getElementsByClassName("header");
        for (let header of headers){
            let title = header.textContent;
            header.addEventListener("click", () => {
                for (let header of headers) {
                    header.textContent = header.textContent.replace('\u25B2', "").replace('\u25BC', "");
                }
                setSortKey(title);
                if (sortKey){
                    header.textContent = `${title}${ascending ? '\u25B2' : '\u25BC'}`;
                }
            });
        }

        updateProcessList();
        window.keyboard.attach();
        window.term[window.currentTerm].term.focus();
        const updateInterval = setInterval(updateProcessList, 1000);
    }
}

module.exports = {
    Toplist
};
