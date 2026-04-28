// Custom lightweight LAS file viewer

window.LASViewer = {
    parse: function(text) {
        const lines = text.split(/\r?\n/);
        let section = '';
        const curves = [];
        const data = [];
        const wellInfo = {};

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;
            if (line.startsWith('~')) {
                section = line.substring(1, 2).toUpperCase();
                continue;
            }

            if (section === 'W') { // Well info
                const parts = line.split(':');
                if (parts.length >= 2) {
                    const left = parts[0];
                    const dotIndex = left.indexOf('.');
                    if (dotIndex > 0) {
                        const key = left.substring(0, dotIndex).trim();
                        let rest = left.substring(dotIndex + 1).trim();
                        // unit and data are separated by the first space
                        const spaceIndex = rest.indexOf(' ');
                        if (spaceIndex > -1) {
                            wellInfo[key] = rest.substring(spaceIndex + 1).trim();
                        } else {
                            // no space? then it's just the unit or data
                            wellInfo[key] = rest;
                        }
                        
                        // Special handling for NULL since it might have no unit but leading spaces are eaten
                        if (key === 'NULL' && spaceIndex === -1) {
                            wellInfo[key] = rest;
                        }
                    }
                }
            } else if (section === 'C') { // Curve info
                const parts = line.split(':');
                if (parts.length >= 2) {
                    const leftSide = parts[0];
                    const dotIndex = leftSide.indexOf('.');
                    if (dotIndex > 0) {
                        const name = leftSide.substring(0, dotIndex).trim();
                        const rest = leftSide.substring(dotIndex + 1).trim();
                        // unit and curve data can be separated by space
                        const unitAndData = rest.split(/\s+/);
                        const unit = unitAndData[0] || '';
                        curves.push({ name: name, unit: unit, description: parts.slice(1).join(':').trim() });
                    }
                }
            } else if (section === 'A') { // Ascii data
                const values = line.split(/\s+/).filter(x => x !== '').map(Number);
                if (values.length > 0 && !isNaN(values[0])) {
                    data.push(values);
                }
            }
        }
        return { wellInfo, curves, data };
    },

    render: function(lasData, containerElement) {
        const { curves, data, wellInfo } = lasData;
        if (!data || !data.length || curves.length < 2) {
            containerElement.innerHTML = '<div style="padding: 20px; color: var(--error);">Error: Invalid or empty LAS data</div>';
            return;
        }

        const nullValue = Number(wellInfo.NULL || -999.25);

        containerElement.innerHTML = '';
        containerElement.style.display = 'flex';
        containerElement.style.overflowX = 'auto';
        containerElement.style.backgroundColor = '#fff';
        containerElement.style.fontFamily = 'monospace';

        const trackWidth = 220;
        const trackHeight = Math.min(800, Math.max(400, data.length * 2)); // Dynamic height based on data

        const depthCurve = data.map(d => d[0]);
        
        // Manual min/max to avoid call stack size exceeded on large arrays
        let minDepth = Infinity;
        let maxDepth = -Infinity;
        for (let j = 0; j < depthCurve.length; j++) {
            if (depthCurve[j] < minDepth) minDepth = depthCurve[j];
            if (depthCurve[j] > maxDepth) maxDepth = depthCurve[j];
        }

        // Draw depth track
        const depthDiv = document.createElement('div');
        depthDiv.style.width = '70px';
        depthDiv.style.flexShrink = '0';
        depthDiv.style.borderRight = '2px solid #333';
        depthDiv.style.position = 'relative';
        depthDiv.style.backgroundColor = '#f9fafb';
        
        // Depth header
        const depthHeader = document.createElement('div');
        depthHeader.style.textAlign = 'center';
        depthHeader.style.padding = '8px';
        depthHeader.style.borderBottom = '2px solid #333';
        depthHeader.style.fontWeight = 'bold';
        depthHeader.style.fontSize = '12px';
        depthHeader.style.height = '50px';
        depthHeader.style.backgroundColor = '#f3f4f6';
        depthHeader.innerHTML = `${curves[0].name}<br><span style="font-weight:normal; font-size:10px; color:#666;">${curves[0].unit}</span>`;
        depthDiv.appendChild(depthHeader);

        // Depth ticks
        const depthCanvas = document.createElement('canvas');
        depthCanvas.width = 70;
        depthCanvas.height = trackHeight;
        depthCanvas.style.display = 'block';
        depthDiv.appendChild(depthCanvas);
        const dCtx = depthCanvas.getContext('2d');
        
        dCtx.fillStyle = '#111';
        dCtx.font = '10px monospace';
        dCtx.textAlign = 'right';
        dCtx.textBaseline = 'middle';

        // Calculate tick interval based on depth range (e.g., every 50 or 100 units)
        const depthRange = maxDepth - minDepth;
        const tickInterval = depthRange > 1000 ? 100 : (depthRange > 100 ? 50 : 10);
        
        const startTick = Math.ceil(minDepth / tickInterval) * tickInterval;
        for (let d = startTick; d <= maxDepth; d += tickInterval) {
            const y = ((d - minDepth) / (maxDepth - minDepth)) * trackHeight;
            dCtx.beginPath();
            dCtx.moveTo(55, y);
            dCtx.lineTo(70, y);
            dCtx.stroke();
            dCtx.fillText(d.toString(), 50, y);
        }
        
        containerElement.appendChild(depthDiv);

        // Define colors for different curves
        const colors = ['#0f766e', '#b91c1c', '#0369a1', '#1d4ed8', '#4338ca', '#6d28d9', '#a21caf', '#be185d'];

        // Draw curve tracks
        for (let i = 1; i < curves.length; i++) {
            const curve = curves[i];
            const values = data.map(d => d[i]).filter(v => v !== nullValue && !isNaN(v));
            if (values.length === 0) continue; // Skip empty curves

            let minVal = Infinity;
            let maxVal = -Infinity;
            for (let j = 0; j < values.length; j++) {
                if (values[j] < minVal) minVal = values[j];
                if (values[j] > maxVal) maxVal = values[j];
            }
            // Add a little padding to min/max
            const padding = (maxVal - minVal) * 0.05 || 1; 
            const displayMin = minVal - padding;
            const displayMax = maxVal + padding;

            const color = colors[(i - 1) % colors.length];

            const trackDiv = document.createElement('div');
            trackDiv.style.width = `${trackWidth}px`;
            trackDiv.style.flexShrink = '0';
            trackDiv.style.borderRight = '1px solid #e5e7eb';
            trackDiv.style.display = 'flex';
            trackDiv.style.flexDirection = 'column';
            trackDiv.style.position = 'relative';

            // Header
            const header = document.createElement('div');
            header.style.textAlign = 'center';
            header.style.padding = '8px';
            header.style.borderBottom = '2px solid #333';
            header.style.fontWeight = 'bold';
            header.style.fontSize = '12px';
            header.style.height = '50px';
            header.style.backgroundColor = '#f9fafb';
            header.style.color = color;
            header.innerHTML = `${curve.name}<br><span style="font-weight:normal; font-size:10px;">${displayMin.toFixed(1)} - ${displayMax.toFixed(1)} ${curve.unit}</span>`;
            trackDiv.appendChild(header);

            // Canvas
            const canvas = document.createElement('canvas');
            canvas.width = trackWidth;
            canvas.height = trackHeight;
            canvas.style.display = 'block';
            trackDiv.appendChild(canvas);
            
            const ctx = canvas.getContext('2d');
            
            // Draw grid lines
            ctx.strokeStyle = '#f3f4f6';
            ctx.lineWidth = 1;
            for (let g = 1; g < 10; g++) {
                const gx = (trackWidth / 10) * g;
                ctx.beginPath();
                ctx.moveTo(gx, 0);
                ctx.lineTo(gx, trackHeight);
                ctx.stroke();
            }

            // Draw curve
            ctx.beginPath();
            let first = true;
            for (let j = 0; j < data.length; j++) {
                const val = data[j][i];
                const depth = data[j][0];
                if (val === nullValue || isNaN(val)) {
                    first = true; // Break line if null
                    continue;
                }

                const x = ((val - displayMin) / (displayMax - displayMin)) * trackWidth;
                const y = ((depth - minDepth) / (maxDepth - minDepth)) * trackHeight;

                if (first) {
                    ctx.moveTo(x, y);
                    first = false;
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.lineJoin = 'round';
            ctx.stroke();

            containerElement.appendChild(trackDiv);
        }
    },

    loadAndRender: async function(url, containerElement) {
        try {
            containerElement.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--muted);">Loading LAS file data...</div>';
            const response = await fetch(url);
            if (!response.ok) throw new Error('Network response was not ok');
            const text = await response.text();
            
            containerElement.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--muted);">Parsing and rendering...</div>';
            
            // Allow UI to update before parsing blocks thread
            setTimeout(() => {
                try {
                    const data = this.parse(text);
                    this.render(data, containerElement);
                } catch (err) {
                    console.error("LAS Parsing error:", err);
                    containerElement.innerHTML = '<div style="padding: 20px; color: var(--error);">Error rendering LAS file. Format may be unsupported.</div>';
                }
            }, 10);
            
        } catch (error) {
            console.error('Error fetching LAS file:', error);
            containerElement.innerHTML = '<div style="padding: 20px; color: var(--error);">Error downloading LAS file for preview.</div>';
        }
    }
};
