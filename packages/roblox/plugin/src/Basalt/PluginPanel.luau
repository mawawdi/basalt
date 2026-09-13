--!strict
local PluginPanel = {}

export type Tone = "neutral" | "active" | "success" | "error"
export type State = {
	title: string,
	detail: string,
	tone: Tone,
	progress: number,
	primaryText: string,
	primaryEnabled: boolean,
	stopVisible: boolean,
	stopText: string?,
	stopEnabled: boolean?,
}

export type Panel = {
	widget: DockWidgetPluginGui,
	setState: (self: Panel, state: State) -> (),
	onPrimary: (self: Panel, callback: () -> ()) -> (),
	onStop: (self: Panel, callback: () -> ()) -> (),
}

local function corner(parent: Instance, radius: number): UICorner
	local value = Instance.new("UICorner")
	value.CornerRadius = UDim.new(0, radius)
	value.Parent = parent
	return value
end

local function label(parent: Instance, name: string, size: number, bold: boolean): TextLabel
	local value = Instance.new("TextLabel")
	value.Name = name
	value.BackgroundTransparency = 1
	value.BorderSizePixel = 0
	value.Font = if bold then Enum.Font.BuilderSansBold else Enum.Font.BuilderSans
	value.TextSize = size
	value.TextXAlignment = Enum.TextXAlignment.Left
	value.TextYAlignment = Enum.TextYAlignment.Center
	value.Parent = parent
	return value
end

function PluginPanel.create(pluginInstance: Plugin): Panel
	local widgetInfo = DockWidgetPluginGuiInfo.new(
		Enum.InitialDockState.Right,
		true,
		false,
		320,
		250,
		280,
		220
	)
	local widget = pluginInstance:CreateDockWidgetPluginGuiAsync("BasaltWorldImport", widgetInfo)
	widget.Name = "BasaltWorldImport"
	widget.Title = "Basalt"

	local root = Instance.new("Frame")
	root.Name = "Root"
	root.BorderSizePixel = 0
	root.Size = UDim2.fromScale(1, 1)
	root.Parent = widget

	local eyebrow = label(root, "Eyebrow", 11, true)
	eyebrow.Position = UDim2.fromOffset(16, 13)
	eyebrow.Size = UDim2.new(1, -32, 0, 18)
	eyebrow.Text = "WORLD IMPORT"

	local heading = label(root, "Heading", 18, true)
	heading.Position = UDim2.fromOffset(16, 30)
	heading.Size = UDim2.new(1, -32, 0, 27)
	heading.Text = "Basalt delivery"

	local card = Instance.new("Frame")
	card.Name = "StatusCard"
	card.BorderSizePixel = 0
	card.Position = UDim2.fromOffset(16, 68)
	card.Size = UDim2.new(1, -32, 0, 91)
	card.Parent = root
	corner(card, 8)
	local cardStroke = Instance.new("UIStroke")
	cardStroke.Thickness = 1
	cardStroke.Parent = card

	local dot = Instance.new("Frame")
	dot.Name = "StatusDot"
	dot.BorderSizePixel = 0
	dot.Position = UDim2.fromOffset(13, 15)
	dot.Size = UDim2.fromOffset(8, 8)
	dot.Parent = card
	corner(dot, 8)

	local statusTitle = label(card, "StatusTitle", 14, true)
	statusTitle.Position = UDim2.fromOffset(30, 8)
	statusTitle.Size = UDim2.new(1, -43, 0, 24)

	local statusDetail = label(card, "StatusDetail", 12, false)
	statusDetail.Position = UDim2.fromOffset(13, 34)
	statusDetail.Size = UDim2.new(1, -26, 0, 31)
	statusDetail.TextWrapped = true
	statusDetail.TextYAlignment = Enum.TextYAlignment.Top

	local progressTrack = Instance.new("Frame")
	progressTrack.Name = "ProgressTrack"
	progressTrack.BorderSizePixel = 0
	progressTrack.Position = UDim2.new(0, 13, 1, -14)
	progressTrack.Size = UDim2.new(1, -26, 0, 4)
	progressTrack.Parent = card
	corner(progressTrack, 4)

	local progressFill = Instance.new("Frame")
	progressFill.Name = "ProgressFill"
	progressFill.BorderSizePixel = 0
	progressFill.Size = UDim2.fromScale(0, 1)
	progressFill.Parent = progressTrack
	corner(progressFill, 4)

	local explanation = label(root, "Explanation", 12, false)
	explanation.Position = UDim2.fromOffset(16, 170)
	explanation.Size = UDim2.new(1, -32, 0, 34)
	explanation.Text = "One ordered queue. Every chunk is checked, imported, then verified."
	explanation.TextWrapped = true
	explanation.TextYAlignment = Enum.TextYAlignment.Top

	local actions = Instance.new("Frame")
	actions.Name = "Actions"
	actions.BackgroundTransparency = 1
	actions.Position = UDim2.new(0, 16, 1, -50)
	actions.Size = UDim2.new(1, -32, 0, 34)
	actions.Parent = root

	local primary = Instance.new("TextButton")
	primary.Name = "PrimaryAction"
	primary.AutoButtonColor = true
	primary.BorderSizePixel = 0
	primary.Font = Enum.Font.BuilderSansBold
	primary.TextSize = 13
	primary.Size = UDim2.fromScale(1, 1)
	primary.Parent = actions
	corner(primary, 6)

	local stop = Instance.new("TextButton")
	stop.Name = "StopAction"
	stop.AutoButtonColor = true
	stop.BorderSizePixel = 0
	stop.Font = Enum.Font.BuilderSansBold
	stop.TextSize = 13
	stop.AnchorPoint = Vector2.new(1, 0)
	stop.Position = UDim2.fromScale(1, 0)
	stop.Size = UDim2.new(0, 86, 1, 0)
	stop.Text = "Stop"
	stop.Visible = false
	stop.Parent = actions
	corner(stop, 6)
	local stopStroke = Instance.new("UIStroke")
	stopStroke.Thickness = 1
	stopStroke.Parent = stop

	local currentState: State = {
		title = "Connecting",
		detail = "Looking for the local Basalt bridge…",
		tone = "active",
		progress = 0,
		primaryText = "Waiting for bridge",
		primaryEnabled = false,
		stopVisible = false,
	}

	local function toneColor(tone: Tone): Color3
		local theme = settings().Studio.Theme
		if tone == "error" then return theme:GetColor(Enum.StudioStyleGuideColor.ErrorText) end
		if tone == "active" then return theme:GetColor(Enum.StudioStyleGuideColor.InfoText) end
		if tone == "success" then return Color3.fromRGB(70, 178, 111) end
		return theme:GetColor(Enum.StudioStyleGuideColor.SubText)
	end

	local function applyTheme(): ()
		local theme = settings().Studio.Theme
		root.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainBackground)
		eyebrow.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.SubText)
		heading.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainText)
		card.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Item)
		cardStroke.Color = theme:GetColor(Enum.StudioStyleGuideColor.Border)
		statusTitle.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.MainText)
		statusDetail.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.SubText)
		explanation.TextColor3 = theme:GetColor(Enum.StudioStyleGuideColor.SubText)
		progressTrack.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Border)
		dot.BackgroundColor3 = toneColor(currentState.tone)
		progressFill.BackgroundColor3 = toneColor(currentState.tone)
		primary.BackgroundColor3 = if currentState.primaryEnabled
			then theme:GetColor(Enum.StudioStyleGuideColor.MainButton)
			else theme:GetColor(Enum.StudioStyleGuideColor.Button)
		primary.TextColor3 = if currentState.primaryEnabled
			then theme:GetColor(Enum.StudioStyleGuideColor.BrightText)
			else theme:GetColor(Enum.StudioStyleGuideColor.DimmedText)
		stop.BackgroundColor3 = theme:GetColor(Enum.StudioStyleGuideColor.Button)
		stop.TextColor3 = if currentState.stopEnabled == true
			then theme:GetColor(Enum.StudioStyleGuideColor.ButtonText)
			else theme:GetColor(Enum.StudioStyleGuideColor.DimmedText)
		stopStroke.Color = theme:GetColor(Enum.StudioStyleGuideColor.ButtonBorder)
	end

	local panel = { widget = widget }
	function panel:setState(state: State): ()
		currentState = state
		statusTitle.Text = state.title
		statusDetail.Text = state.detail
		progressFill.Size = UDim2.fromScale(math.clamp(state.progress, 0, 1), 1)
		primary.Text = state.primaryText
		primary.Active = state.primaryEnabled
		primary.AutoButtonColor = state.primaryEnabled
		stop.Visible = state.stopVisible
		stop.Text = state.stopText or "Stop"
		stop.Active = state.stopEnabled == true
		stop.AutoButtonColor = state.stopEnabled == true
		primary.Size = if state.stopVisible then UDim2.new(1, -96, 1, 0) else UDim2.fromScale(1, 1)
		applyTheme()
	end
	function panel:onPrimary(callback: () -> ()): ()
		primary.Activated:Connect(function()
			if currentState.primaryEnabled then callback() end
		end)
	end
	function panel:onStop(callback: () -> ()): ()
		stop.Activated:Connect(function()
			if currentState.stopEnabled == true then callback() end
		end)
	end

	settings().Studio.ThemeChanged:Connect(applyTheme)
	panel:setState(currentState)
	return panel :: any
end

return PluginPanel
