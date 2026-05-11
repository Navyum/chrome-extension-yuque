/**
 * Official Yuque shape definitions and high-variance geometry renderers.
 *
 * Values in this file are copied from Yuque's shape registry coordinate system
 * and scaled at render time. Add new official shapes here instead of hard-coding
 * paths inside the main board converter.
 */

const OFFICIAL_FLOWCHART_SHAPES = {
  document: {
    width: 120,
    height: 72,
    outline: [
      ['M', 1, 0],
      ['L', 119, 0],
      ['C', 119.552285, 0, 120, 0.4477153, 120, 1],
      ['L', 120, 63.2943312],
      ['C', 119.999975, 63.8466024, 119.552271, 64.2943066, 119, 64.2943066],
      ['C', 118.874051, 64.2943066, 118.749236, 64.2705132, 118.63212, 64.2241781],
      ['C', 108.562735, 60.240377, 99.0186463, 58.2432881, 89.9998549, 58.2329113],
      ['C', 75.8605271, 58.216643, 73.9215376, 58.9595768, 59.9999032, 65.0379103],
      ['C', 46.0782688, 71.1162438, 44.1653018, 71.9832913, 29.9999516, 72],
      ['C', 20.7325008, 72.010162, 10.9291929, 69.6914094, 0.590028, 65.0437423],
      ['C', 0.2309588, 64.882365, 0, 64.5253236, 0, 64.1316572],
      ['L', 0, 1],
      ['C', 0, 0.4477153, 0.4477153, 0, 1, 0],
      ['Z']
    ],
    scene: []
  },
  multiDocument: {
    width: 120,
    height: 80,
    outline: [
      ['M', 119, 0],
      ['C', 119.552285, 0, 120, 0.4477153, 120, 1],
      ['L', 120, 57.6634711],
      ['C', 120.00004, 58.2157781, 119.552307, 58.6635113, 119, 58.6635113],
      ['C', 118.846121, 58.6635113, 118.694318, 58.6280008, 118.556406, 58.5597438],
      ['C', 117.079303, 57.8286782, 115.893834, 57.3066398, 115, 56.9936286],
      ['L', 114.744, 56.868],
      ['L', 114.744526, 63.1694166],
      ['C', 114.744553, 63.7217167, 114.296826, 64.1694445, 113.744526, 64.1694445],
      ['C', 113.610972, 64.1694445, 113.478771, 64.1426929, 113.355724, 64.0907684],
      ['C', 111.834645, 63.4488877, 110.620494, 62.9604303, 109.71327, 62.6253962],
      ['L', 109.714286, 71.1461039],
      ['C', 109.714249, 71.6983687, 109.26655, 72.1460677, 108.714286, 72.1460677],
      ['C', 108.59377, 72.1460677, 108.474247, 72.1242823, 108.361482, 72.0817624],
      ['C', 98.4971172, 68.3622546, 89.1471649, 66.4976545, 80.3116246, 66.4879622],
      ['C', 66.4538962, 66.4727606, 64.5535237, 67.1669765, 50.9091531, 72.8467226],
      ['C', 37.2647825, 78.5264687, 35.3899142, 79.3366596, 21.5066816, 79.351889],
      ['C', 12.4628087, 79.3615937, 5.4112062, 77.2136321, 0.351874, 72.9080041],
      ['C', 0.1286374, 72.7179927, 0, 72.4396044, 0, 72.1464509],
      ['L', 0, 11.7804604],
      ['C', 0, 11.2281757, 0.4477153, 10.7804604, 1, 10.7804604],
      ['L', 5.255, 10.78],
      ['L', 5.2554745, 6.3902302],
      ['C', 5.2554745, 5.8379455, 5.7031897, 5.3902302, 6.2554745, 5.3902302],
      ['L', 10.51, 5.39],
      ['L', 10.5109489, 1],
      ['C', 10.5109489, 0.4477153, 10.9586642, 0, 11.5109489, 0],
      ['L', 119, 0],
      ['Z']
    ],
    scene: [
      [
        ['M', 10, 5.3902302],
        ['L', 113.744526, 5.3902302],
        ['C', 114.29681, 5.3902302, 114.744526, 5.8379455, 114.744526, 6.3902302],
        ['L', 114.744526, 61.6827625],
        ['L', 114.744526, 61.6827625]
      ],
      [
        ['M', 3, 10.7804604],
        ['L', 108.714286, 10.7804604],
        ['C', 109.26657, 10.7804604, 109.714286, 11.2281757, 109.714286, 11.7804604],
        ['L', 109.714286, 69.602221],
        ['L', 109.714286, 69.602221]
      ]
    ]
  }
};

export function renderDocumentPath(x, y, w, h, fill, stroke, strokeWidth) {
  return renderOfficialPathShape(OFFICIAL_FLOWCHART_SHAPES.document, x, y, w, h, fill, stroke, strokeWidth);
}

export function renderMultiDocumentPath(x, y, w, h, fill, stroke, strokeWidth) {
  return renderOfficialPathShape(OFFICIAL_FLOWCHART_SHAPES.multiDocument, x, y, w, h, fill, stroke, strokeWidth);
}

function renderOfficialPathShape(definition, x, y, w, h, fill, stroke, strokeWidth) {
  const scaleX = w / definition.width;
  const scaleY = h / definition.height;
  const outline = `<path d="${scalePath(definition.outline, x, y, scaleX, scaleY)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  const scene = definition.scene.map(commands => (
    `<path d="${scalePath(commands, x, y, scaleX, scaleY)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
  )).join('');
  return outline + scene;
}

function scalePath(commands, x, y, scaleX, scaleY) {
  return commands.map(([cmd, ...nums]) => {
    if (cmd === 'Z') return 'Z';
    const scaled = nums.map((num, index) => index % 2 === 0 ? x + num * scaleX : y + num * scaleY);
    return `${cmd}${scaled.join(',')}`;
  }).join(' ');
}

export function renderArrowPolygon(x, y, w, h, fill, stroke, strokeWidth, shape) {
  const rel = officialArrowPath(w, h, shape);
  const d = rel.map(([cmd, px, py]) => {
    if (cmd === 'Z') return 'Z';
    return `${cmd}${x + px},${y + py}`;
  }).join(' ');
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

function officialArrowPath(w, h, shape) {
  const midY = h / 2;

  // These formulas mirror Yuque's own basic geometry definitions. Keeping the
  // proportions here centralized prevents arrow variants from drifting apart
  // when the same shape is reused in fishbone, roadmap, and module diagrams.
  if (shape === 'arrow-1') {
    const head = h / 80 * 50;
    if (head >= w) return [['M', w, 0], ['L', 0, midY], ['L', w, h], ['Z']];
    return [
      ['M', head, h / 4],
      ['L', head, 0],
      ['L', 0, midY],
      ['L', head, h],
      ['L', head, h * 3 / 4],
      ['L', w, h * 3 / 4],
      ['L', w, h / 4],
      ['Z']
    ];
  }

  if (shape === 'arrow-2') {
    const head = h / 80 * 50;
    if (head >= w) return [['M', 0, 0], ['L', w, midY], ['L', 0, h], ['Z']];
    return [
      ['M', w - head, h / 4],
      ['L', w - head, 0],
      ['L', w, midY],
      ['L', w - head, h],
      ['L', w - head, h * 3 / 4],
      ['L', 0, h * 3 / 4],
      ['L', 0, h / 4],
      ['Z']
    ];
  }

  if (shape === 'process-arrow') {
    const head = h / 2;
    if (head >= w) return [['M', 0, 0], ['L', w, midY], ['L', 0, h], ['Z']];
    return [
      ['M', 0, 0],
      ['L', w - head, 0],
      ['L', w, midY],
      ['L', w - head, h],
      ['L', 0, h],
      ['L', head, midY],
      ['L', 0, 0],
      ['Z']
    ];
  }

  const head = h / 2;
  if (head >= w) return [['M', 0, 0], ['L', w, midY], ['L', 0, h], ['Z']];
  return [
    ['M', 0, 0],
    ['L', w - head, 0],
    ['L', w, midY],
    ['L', w - head, h],
    ['L', 0, h],
    ['Z']
  ];
}

export function arrowTextRegion(x, y, w, h, shape) {
  const padding = 4;
  let minX = padding;
  let minY = padding;
  let maxX = w - padding;
  let maxY = h - padding;

  if (shape === 'arrow-1') {
    const head = h / 80 * 50;
    if (head < w) {
      minX = head / 2;
      minY = h / 4 + padding;
      maxY = h * 3 / 4 - padding;
    }
  } else if (shape === 'arrow-2') {
    const head = h / 80 * 50;
    if (head < w) {
      minY = h / 4 + padding;
      maxX = w - head / 2;
      maxY = h * 3 / 4 - padding;
    }
  } else {
    const head = h / 2;
    if (head < w) {
      minX = shape === 'process-arrow' ? head + padding : padding;
      maxX = w - head / 2 - padding;
    }
  }

  return {
    x: x + minX,
    y: y + minY,
    width: Math.max(maxX - minX, 1),
    height: Math.max(maxY - minY, 1)
  };
}

// ── Text ──
